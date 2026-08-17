import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  collectionJobs,
  collectionTasks,
  sources,
  type CollectorDatabase,
} from "@ao3-offsite/database";

export interface ClaimedTask {
  taskId: number;
  jobId: number;
  sourceWorkId: string;
  attempts: number;
  leaseToken: string;
  leaseExpiresAt: Date;
  source: {
    id: number;
    origin: string;
    userAgent: string;
    includeAdult: boolean;
    minimumDelayMs: number;
    dailyRequestBudget: number | null;
    dailyByteBudget: number | null;
    requestTimeoutMs: number;
    maximumResponseBytes: number;
    maximumFailureAttempts: number;
  };
}

export type Completion =
  | { status: "succeeded" }
  | { status: "terminal_failed"; code: string; message: string }
  | { status: "retryable_failed"; code: string; message: string; availableAt: Date }
  | { status: "cancelled"; message?: string };

export class TaskLeaseStore {
  constructor(private readonly db: CollectorDatabase) {}

  async claim(workerId: string, limit = 1, leaseMilliseconds = 120_000): Promise<ClaimedTask[]> {
    if (!workerId.trim()) throw new Error("workerId is required");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error("claim limit must be between 1 and 100");
    if (leaseMilliseconds < 10_000) throw new Error("lease must be at least 10 seconds");
    const now = new Date();
    const leaseExpiresAt = new Date(now.getTime() + leaseMilliseconds);
    const leaseToken = `${workerId}:${randomUUID()}`;

    await this.db.execute(sql`
      UPDATE collection_tasks AS task
      INNER JOIN collection_jobs AS job ON job.id = task.job_id
      INNER JOIN sources AS source ON source.id = job.source_id
      SET task.status = 'leased',
          task.leased_by = ${leaseToken},
          task.lease_expires_at = ${leaseExpiresAt},
          task.updated_at = ${now},
          job.status = CASE WHEN job.status = 'queued' THEN 'running' ELSE job.status END,
          job.started_at = COALESCE(job.started_at, ${now}),
          job.updated_at = ${now}
      WHERE task.status IN ('queued', 'retryable_failed')
        AND task.available_at <= ${now}
        AND (task.lease_expires_at IS NULL OR task.lease_expires_at <= ${now})
        AND job.status IN ('queued', 'running')
        AND source.paused = false
      ORDER BY task.available_at, task.id
      LIMIT ${limit}
    `);
    await this.db.update(collectionTasks)
      .set({ attempts: sql`${collectionTasks.attempts} + 1` })
      .where(eq(collectionTasks.leasedBy, leaseToken));

    const rows = await this.db.select({
      taskId: collectionTasks.id,
      jobId: collectionTasks.jobId,
      sourceWorkId: collectionTasks.sourceWorkId,
      attempts: collectionTasks.attempts,
      sourceId: sources.id,
      origin: sources.origin,
      userAgent: sources.userAgent,
      includeAdult: sources.includeAdult,
      minimumDelayMs: sources.minimumDelayMs,
      dailyRequestBudget: sources.dailyRequestBudget,
      dailyByteBudget: sources.dailyByteBudget,
      requestTimeoutMs: sources.requestTimeoutMs,
      maximumResponseBytes: sources.maximumResponseBytes,
      maximumFailureAttempts: sources.maximumFailureAttempts,
    }).from(collectionTasks)
      .innerJoin(collectionJobs, eq(collectionJobs.id, collectionTasks.jobId))
      .innerJoin(sources, eq(sources.id, collectionJobs.sourceId))
      .where(eq(collectionTasks.leasedBy, leaseToken));

    return rows.map((row) => ({
      taskId: row.taskId,
      jobId: row.jobId,
      sourceWorkId: row.sourceWorkId,
      attempts: row.attempts,
      leaseToken,
      leaseExpiresAt,
      source: {
        id: row.sourceId,
        origin: row.origin,
        userAgent: row.userAgent,
        includeAdult: row.includeAdult,
        minimumDelayMs: row.minimumDelayMs,
        dailyRequestBudget: row.dailyRequestBudget,
        dailyByteBudget: row.dailyByteBudget,
        requestTimeoutMs: row.requestTimeoutMs,
        maximumResponseBytes: row.maximumResponseBytes,
        maximumFailureAttempts: row.maximumFailureAttempts,
      },
    }));
  }

  async heartbeat(taskId: number, leaseToken: string, leaseMilliseconds = 120_000): Promise<boolean> {
    const now = new Date();
    const result = await this.db.update(collectionTasks).set({
      leaseExpiresAt: new Date(now.getTime() + leaseMilliseconds),
      updatedAt: now,
    }).where(and(
      eq(collectionTasks.id, taskId),
      eq(collectionTasks.status, "leased"),
      eq(collectionTasks.leasedBy, leaseToken),
    ));
    return affectedRows(result) === 1;
  }

  async complete(taskId: number, leaseToken: string, completion: Completion): Promise<boolean> {
    const leased = await this.db.select({ jobId: collectionTasks.jobId }).from(collectionTasks).where(and(
      eq(collectionTasks.id, taskId), eq(collectionTasks.status, "leased"), eq(collectionTasks.leasedBy, leaseToken),
    )).limit(1);
    const jobId = leased[0]?.jobId;
    if (!jobId) return false;
    const now = new Date();
    const error = completion.status === "succeeded" ? null : completion;
    const result = await this.db.update(collectionTasks).set({
      status: completion.status,
      availableAt: completion.status === "retryable_failed" ? completion.availableAt : now,
      leaseExpiresAt: null,
      leasedBy: null,
      lastErrorCode: completion.status === "terminal_failed" || completion.status === "retryable_failed" ? completion.code : null,
      lastErrorMessage: error && "message" in error ? error.message ?? null : null,
      updatedAt: now,
    }).where(and(
      eq(collectionTasks.id, taskId), eq(collectionTasks.status, "leased"), eq(collectionTasks.leasedBy, leaseToken),
    ));
    if (affectedRows(result) !== 1) return false;
    await this.recomputeJob(jobId, now);
    return true;
  }

  async defer(taskId: number, leaseToken: string, availableAt: Date, reason: string): Promise<boolean> {
    const result = await this.db.update(collectionTasks).set({
      status: "queued",
      availableAt,
      leaseExpiresAt: null,
      leasedBy: null,
      lastErrorCode: reason,
      lastErrorMessage: null,
      updatedAt: new Date(),
    }).where(and(
      eq(collectionTasks.id, taskId), eq(collectionTasks.status, "leased"), eq(collectionTasks.leasedBy, leaseToken),
    ));
    return affectedRows(result) === 1;
  }

  async reclaimExpired(now = new Date()): Promise<void> {
    await this.db.execute(sql`
      UPDATE collection_tasks AS task
      INNER JOIN collection_jobs AS job ON job.id = task.job_id
      SET task.status = 'retryable_failed',
          task.available_at = ${now},
          task.lease_expires_at = NULL,
          task.leased_by = NULL,
          task.last_error_code = 'worker_lease_expired',
          task.last_error_message = 'The worker lease expired before completion.',
          task.updated_at = ${now}
      WHERE task.status = 'leased'
        AND task.lease_expires_at <= ${now}
        AND job.status IN ('queued', 'running')
    `);
  }

  async pauseJob(jobId: number): Promise<void> {
    await this.db.update(collectionJobs).set({ status: "paused", updatedAt: new Date() }).where(and(
      eq(collectionJobs.id, jobId), inArray(collectionJobs.status, ["queued", "running"]),
    ));
  }

  async resumeJob(jobId: number): Promise<void> {
    await this.db.update(collectionJobs).set({ status: "running", updatedAt: new Date() }).where(eq(collectionJobs.id, jobId));
  }

  async cancelJob(jobId: number): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.update(collectionJobs).set({ status: "cancelled", completedAt: now, updatedAt: now }).where(eq(collectionJobs.id, jobId));
      await tx.update(collectionTasks).set({ status: "cancelled", leaseExpiresAt: null, leasedBy: null, updatedAt: now })
        .where(and(eq(collectionTasks.jobId, jobId), inArray(collectionTasks.status, ["queued", "retryable_failed"])));
    });
  }

  private async recomputeJob(jobId: number, now: Date): Promise<void> {
    await this.db.execute(sql`
      UPDATE collection_jobs AS job
      SET job.succeeded_count = (SELECT COUNT(*) FROM collection_tasks WHERE job_id = ${jobId} AND status = 'succeeded'),
          job.failed_count = (SELECT COUNT(*) FROM collection_tasks WHERE job_id = ${jobId} AND status = 'terminal_failed'),
          job.skipped_count = (SELECT COUNT(*) FROM collection_tasks WHERE job_id = ${jobId} AND status = 'cancelled'),
          job.status = CASE
            WHEN job.status = 'cancelled' THEN 'cancelled'
            WHEN NOT EXISTS (
              SELECT 1 FROM collection_tasks
              WHERE job_id = ${jobId} AND status IN ('queued', 'leased', 'retryable_failed')
            ) THEN 'completed'
            ELSE job.status
          END,
          job.completed_at = CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM collection_tasks
              WHERE job_id = ${jobId} AND status IN ('queued', 'leased', 'retryable_failed')
            ) THEN ${now}
            ELSE job.completed_at
          END,
          job.updated_at = ${now}
      WHERE job.id = ${jobId}
    `);
  }
}

function affectedRows(result: unknown): number {
  const candidate = Array.isArray(result) ? result[0] : result;
  if (candidate && typeof candidate === "object" && "affectedRows" in candidate) {
    return Number((candidate as { affectedRows: unknown }).affectedRows);
  }
  return 0;
}
