import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, desc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { exportRuns, sources, type CollectorDatabase } from "@ao3-offsite/database";

export interface ClaimedExport {
  id: number;
  sourceId: number;
  sourceKey: string;
  origin: string;
  packageId: string;
  previousPackageId: string | null;
  sequenceNumber: number;
  outputDirectory: string;
  maximumWorks: number;
  leaseToken: string;
}

export class ExportQueueStore {
  constructor(private readonly db: CollectorDatabase) {}

  async createRequest(sourceId: number, outputRoot: string, maximumWorks = 500): Promise<{ id: number; packageId: string }> {
    if (!Number.isInteger(maximumWorks) || maximumWorks < 1 || maximumWorks > 5_000) {
      throw new Error("maximumWorks must be between 1 and 5000");
    }
    const packageId = randomUUID();
    const result = await this.db.insert(exportRuns).values({
      sourceId,
      packageId,
      status: "queued",
      outputDirectory: join(outputRoot, packageId),
      maximumWorks,
    }).$returningId();
    const id = result[0]?.id;
    if (!id) throw new Error("Export request did not return an ID");
    return { id, packageId };
  }

  async claim(workerId: string, leaseMilliseconds = 300_000): Promise<ClaimedExport | null> {
    const now = new Date();
    const candidates = await this.db.selectDistinct({ sourceId: exportRuns.sourceId }).from(exportRuns).where(or(
      eq(exportRuns.status, "queued"),
      and(inArray(exportRuns.status, ["leased", "writing"]), lte(exportRuns.leaseExpiresAt, now)),
    )).orderBy(exportRuns.sourceId).limit(50);

    for (const candidate of candidates) {
      const leaseToken = `${workerId}:${randomUUID()}`;
      const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);
      const claim = await this.db.transaction(async (tx) => {
        const sourceLock = await tx.update(sources).set({
          exportLeaseToken: leaseToken,
          exportLeaseExpiresAt: leaseExpiresAt,
          updatedAt: now,
        }).where(and(
          eq(sources.id, candidate.sourceId),
          or(isNull(sources.exportLeaseExpiresAt), lte(sources.exportLeaseExpiresAt, now)),
        ));
        if (affectedRows(sourceLock) !== 1) return null;

        const row = (await tx.select({
          id: exportRuns.id,
          sourceId: exportRuns.sourceId,
          sourceKey: sources.key,
          origin: sources.origin,
          packageId: exportRuns.packageId,
          previousPackageId: exportRuns.previousPackageId,
          sequenceNumber: exportRuns.sequenceNumber,
          outputDirectory: exportRuns.outputDirectory,
          maximumWorks: exportRuns.maximumWorks,
          nextExportSequence: sources.nextExportSequence,
        }).from(exportRuns).innerJoin(sources, eq(sources.id, exportRuns.sourceId)).where(and(
          eq(exportRuns.sourceId, candidate.sourceId),
          or(
            eq(exportRuns.status, "queued"),
            and(inArray(exportRuns.status, ["leased", "writing"]), lte(exportRuns.leaseExpiresAt, now)),
          ),
        )).orderBy(exportRuns.id).limit(1).for("update"))[0];
        if (!row) {
          await tx.update(sources).set({ exportLeaseToken: null, exportLeaseExpiresAt: null }).where(eq(sources.exportLeaseToken, leaseToken));
          return null;
        }

        let sequenceNumber = row.sequenceNumber;
        let previousPackageId = row.previousPackageId;
        if (sequenceNumber === null) {
          sequenceNumber = row.nextExportSequence;
          const previous = (await tx.select({ packageId: exportRuns.packageId }).from(exportRuns).where(and(
            eq(exportRuns.sourceId, row.sourceId), eq(exportRuns.status, "completed"),
          )).orderBy(desc(exportRuns.sequenceNumber)).limit(1))[0];
          previousPackageId = previous?.packageId ?? null;
          await tx.update(sources).set({ nextExportSequence: row.nextExportSequence + 1 }).where(eq(sources.id, row.sourceId));
        }
        await tx.update(exportRuns).set({
          status: "leased",
          leaseToken,
          leaseExpiresAt,
          sequenceNumber,
          previousPackageId,
          updatedAt: now,
        }).where(eq(exportRuns.id, row.id));
        return {
          id: row.id,
          sourceId: row.sourceId,
          sourceKey: row.sourceKey,
          origin: row.origin,
          packageId: row.packageId,
          previousPackageId,
          sequenceNumber,
          outputDirectory: row.outputDirectory,
          maximumWorks: row.maximumWorks,
          leaseToken,
        };
      });
      if (claim) return claim;
    }
    return null;
  }

  async heartbeat(id: number, leaseToken: string, leaseMilliseconds = 300_000): Promise<boolean> {
    const now = new Date();
    const expiresAt = new Date(now.getTime() + leaseMilliseconds);
    return this.db.transaction(async (tx) => {
      const result = await tx.update(exportRuns).set({ leaseExpiresAt: expiresAt, updatedAt: now })
        .where(and(eq(exportRuns.id, id), eq(exportRuns.leaseToken, leaseToken), inArray(exportRuns.status, ["leased", "writing"])));
      if (affectedRows(result) !== 1) return false;
      await tx.update(sources).set({ exportLeaseExpiresAt: expiresAt, updatedAt: now })
        .where(eq(sources.exportLeaseToken, leaseToken));
      return true;
    });
  }

  async markWriting(id: number, leaseToken: string): Promise<boolean> {
    const result = await this.db.update(exportRuns).set({ status: "writing", updatedAt: new Date() })
      .where(and(eq(exportRuns.id, id), eq(exportRuns.leaseToken, leaseToken), eq(exportRuns.status, "leased")));
    return affectedRows(result) === 1;
  }

  async markFailed(id: number, leaseToken: string, error: unknown): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.update(exportRuns).set({
        status: "failed",
        errorMessage: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        completedAt: now, leaseToken: null, leaseExpiresAt: null, updatedAt: now,
      }).where(and(eq(exportRuns.id, id), eq(exportRuns.leaseToken, leaseToken)));
      await tx.update(sources).set({ exportLeaseToken: null, exportLeaseExpiresAt: null, updatedAt: now })
        .where(eq(sources.exportLeaseToken, leaseToken));
    });
  }
}

function affectedRows(result: unknown): number {
  const candidate = Array.isArray(result) ? result[0] : result;
  return candidate && typeof candidate === "object" && "affectedRows" in candidate
    ? Number((candidate as { affectedRows: unknown }).affectedRows)
    : 0;
}
