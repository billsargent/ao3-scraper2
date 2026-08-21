import { randomUUID } from "node:crypto";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { collectionJobs, collectionTasks, observations, type CollectorDatabase } from "@ao3-offsite/database";
import { IdRangeConfigurationSchema } from "./planner.js";
import type { EventLog } from "./event-log.js";

export interface ClaimedPlanningJob {
  id: number;
  sourceId: number;
  configuration: { start: number; end: number; batchSize: number };
  cursor: number;
  leaseToken: string;
}

export class JobPlannerStore {
  constructor(private readonly db: CollectorDatabase) {}

  async claim(workerId: string, leaseMilliseconds = 120_000): Promise<ClaimedPlanningJob | null> {
    const now = new Date();
    const leaseToken = `${workerId}:${randomUUID()}`;
    const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);
    await this.db.execute(sql`
      UPDATE collection_jobs
      SET planning_status = 'leased', planning_lease_token = ${leaseToken},
          planning_lease_expires_at = ${leaseExpiresAt}, updated_at = ${now}
      WHERE job_type = 'id_range'
        AND status IN ('queued', 'running')
        AND (
          planning_status = 'queued'
          OR (planning_status IN ('leased', 'planning') AND planning_lease_expires_at <= ${now})
        )
      ORDER BY id
      LIMIT 1
    `);
    const row = (await this.db.select({
      id: collectionJobs.id,
      sourceId: collectionJobs.sourceId,
      configuration: collectionJobs.configuration,
      planningCursor: collectionJobs.planningCursor,
    }).from(collectionJobs).where(eq(collectionJobs.planningLeaseToken, leaseToken)).limit(1))[0];
    if (!row) return null;
    const configuration = IdRangeConfigurationSchema.parse(row.configuration);
    return {
      id: row.id,
      sourceId: row.sourceId,
      configuration,
      cursor: row.planningCursor ?? configuration.start,
      leaseToken,
    };
  }

  async markPlanning(id: number, leaseToken: string): Promise<boolean> {
    const result = await this.db.update(collectionJobs).set({ planningStatus: "planning", updatedAt: new Date() })
      .where(and(eq(collectionJobs.id, id), eq(collectionJobs.planningLeaseToken, leaseToken), eq(collectionJobs.planningStatus, "leased")));
    return affectedRows(result) === 1;
  }

  async enqueueBatch(id: number, leaseToken: string, sourceWorkIds: string[], nextCursor: number, leaseMilliseconds = 120_000): Promise<boolean> {
    const now = new Date();
    return this.db.transaction(async (tx) => {
      const job = (await tx.select({ status: collectionJobs.status, sourceId: collectionJobs.sourceId }).from(collectionJobs).where(and(
        eq(collectionJobs.id, id), eq(collectionJobs.planningLeaseToken, leaseToken), eq(collectionJobs.planningStatus, "planning"),
      )).limit(1).for("update"))[0];
      if (!job || job.status === "cancelled") return false;
      if (sourceWorkIds.length) {
        // AO3 never reuses work IDs, so IDs we have already observed as gone
        // (not_found) must not be re-enqueued. Filter them out before insert.
        const alreadyNotFound = new Set((await tx.select({ sourceWorkId: observations.sourceWorkId })
          .from(observations)
          .where(and(
            eq(observations.sourceId, job.sourceId),
            eq(observations.availability, "not_found"),
            inArray(observations.sourceWorkId, sourceWorkIds),
          ))).map((row) => row.sourceWorkId));
        const pending = sourceWorkIds.filter((sourceWorkId) => !alreadyNotFound.has(sourceWorkId));
        if (pending.length) {
          await tx.insert(collectionTasks).values(pending.map((sourceWorkId) => ({
            jobId: id, sourceWorkId, status: "queued" as const, availableAt: now,
          }))).onDuplicateKeyUpdate({ set: { updatedAt: now } });
        }
      }
      const taskCount = (await tx.select({ value: count() }).from(collectionTasks).where(eq(collectionTasks.jobId, id)))[0]?.value ?? 0;
      await tx.update(collectionJobs).set({
        discoveredCount: taskCount,
        planningCursor: nextCursor,
        planningLeaseExpiresAt: new Date(now.getTime() + leaseMilliseconds),
        updatedAt: now,
      }).where(eq(collectionJobs.id, id));
      return true;
    });
  }

  async complete(id: number, leaseToken: string): Promise<void> {
    await this.db.update(collectionJobs).set({
      planningStatus: "completed", planningLeaseToken: null, planningLeaseExpiresAt: null,
      planningError: null, updatedAt: new Date(),
    }).where(and(eq(collectionJobs.id, id), eq(collectionJobs.planningLeaseToken, leaseToken)));
  }

  async fail(id: number, leaseToken: string, error: unknown): Promise<void> {
    await this.db.update(collectionJobs).set({
      planningStatus: "failed", planningLeaseToken: null, planningLeaseExpiresAt: null,
      planningError: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
      status: "failed", completedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(collectionJobs.id, id), eq(collectionJobs.planningLeaseToken, leaseToken)));
  }
}

export class JobPlannerWorker {
  constructor(
    private readonly workerId: string,
    private readonly queue: JobPlannerStore,
    private readonly leaseMilliseconds = 120_000,
    private readonly events?: EventLog,
  ) {}

  async processOne(): Promise<boolean> {
    const claim = await this.queue.claim(this.workerId, this.leaseMilliseconds);
    if (!claim) return false;
    await this.events?.record({
      level: "info",
      event: "planner_claimed",
      message: `Claimed job #${claim.id} for planning.`,
      context: { jobId: claim.id, sourceId: claim.sourceId, cursor: claim.cursor, end: claim.configuration.end, batchSize: claim.configuration.batchSize },
    });
    if (!await this.queue.markPlanning(claim.id, claim.leaseToken)) return false;
    try {
      let cursor = claim.cursor;
      while (cursor <= claim.configuration.end) {
        const batchEnd = Math.min(claim.configuration.end, cursor + claim.configuration.batchSize - 1);
        const ids = Array.from({ length: batchEnd - cursor + 1 }, (_value, index) => String(cursor + index));
        cursor = batchEnd + 1;
        if (!await this.queue.enqueueBatch(claim.id, claim.leaseToken, ids, cursor, this.leaseMilliseconds)) {
          await this.events?.record({
            level: "warn",
            event: "planner_batch_rejected",
            message: `Planning batch rejected for job #${claim.id} (job paused or cancelled).`,
            context: { jobId: claim.id, cursor },
          });
          return true;
        }
      }
      await this.queue.complete(claim.id, claim.leaseToken);
      await this.events?.record({
        level: "info",
        event: "planner_completed",
        message: `Finished planning job #${claim.id}.`,
        context: { jobId: claim.id, end: claim.configuration.end },
      });
    } catch (error) {
      await this.queue.fail(claim.id, claim.leaseToken, error);
      await this.events?.record({
        level: "error",
        event: "planner_failed",
        message: `Planning failed for job #${claim.id}: ${error instanceof Error ? error.message : String(error)}`,
        context: {
          jobId: claim.id,
          cursor: claim.cursor,
          end: claim.configuration.end,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
      });
    }
    return true;
  }

  async run(signal: AbortSignal, idleMilliseconds = 2_000): Promise<void> {
    while (!signal.aborted) {
      if (!await this.processOne()) await new Promise((resolve) => setTimeout(resolve, idleMilliseconds));
    }
  }
}

function affectedRows(result: unknown): number {
  const candidate = Array.isArray(result) ? result[0] : result;
  return candidate && typeof candidate === "object" && "affectedRows" in candidate
    ? Number((candidate as { affectedRows: unknown }).affectedRows)
    : 0;
}
