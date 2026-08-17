import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { exportRuns, sources, type CollectorDatabase } from "@ao3-offsite/database";

export interface ClaimedExport {
  id: number;
  sourceId: number;
  sourceKey: string;
  origin: string;
  packageId: string;
  previousPackageId: string | null;
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
    const leaseToken = `${workerId}:${randomUUID()}`;
    const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);
    await this.db.execute(sql`
      UPDATE export_runs
      SET status = 'leased', lease_token = ${leaseToken}, lease_expires_at = ${leaseExpiresAt}, updated_at = ${now}
      WHERE status = 'queued' OR (status IN ('leased', 'writing') AND lease_expires_at <= ${now})
      ORDER BY id
      LIMIT 1
    `);
    const row = (await this.db.select({
      id: exportRuns.id,
      sourceId: exportRuns.sourceId,
      sourceKey: sources.key,
      origin: sources.origin,
      packageId: exportRuns.packageId,
      outputDirectory: exportRuns.outputDirectory,
      maximumWorks: exportRuns.maximumWorks,
    }).from(exportRuns).innerJoin(sources, eq(sources.id, exportRuns.sourceId))
      .where(eq(exportRuns.leaseToken, leaseToken)).limit(1))[0];
    if (!row) return null;
    const previous = (await this.db.select({ packageId: exportRuns.packageId }).from(exportRuns).where(and(
      eq(exportRuns.sourceId, row.sourceId), eq(exportRuns.status, "completed"),
    )).orderBy(desc(exportRuns.completedAt)).limit(1))[0];
    await this.db.update(exportRuns).set({ previousPackageId: previous?.packageId ?? null }).where(eq(exportRuns.id, row.id));
    return { ...row, previousPackageId: previous?.packageId ?? null, leaseToken };
  }

  async heartbeat(id: number, leaseToken: string, leaseMilliseconds = 300_000): Promise<boolean> {
    const result = await this.db.update(exportRuns).set({
      leaseExpiresAt: new Date(Date.now() + leaseMilliseconds), updatedAt: new Date(),
    }).where(and(eq(exportRuns.id, id), eq(exportRuns.leaseToken, leaseToken), inArray(exportRuns.status, ["leased", "writing"])));
    return affectedRows(result) === 1;
  }

  async markWriting(id: number, leaseToken: string): Promise<boolean> {
    const result = await this.db.update(exportRuns).set({ status: "writing", updatedAt: new Date() })
      .where(and(eq(exportRuns.id, id), eq(exportRuns.leaseToken, leaseToken), eq(exportRuns.status, "leased")));
    return affectedRows(result) === 1;
  }

  async markFailed(id: number, leaseToken: string, error: unknown): Promise<void> {
    await this.db.update(exportRuns).set({
      status: "failed",
      errorMessage: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      completedAt: new Date(), leaseToken: null, leaseExpiresAt: null, updatedAt: new Date(),
    }).where(and(eq(exportRuns.id, id), eq(exportRuns.leaseToken, leaseToken)));
  }
}

function affectedRows(result: unknown): number {
  const candidate = Array.isArray(result) ? result[0] : result;
  return candidate && typeof candidate === "object" && "affectedRows" in candidate
    ? Number((candidate as { affectedRows: unknown }).affectedRows)
    : 0;
}
