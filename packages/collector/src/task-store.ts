import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  collectionJobs,
  collectionTasks,
  sources,
  type CollectorDatabase,
} from "@ao3-offsite/database";
import type { EventLog } from "./event-log.js";

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
    captureComments: boolean;
    captureKudos: boolean;
    captureBookmarks: boolean;
    maximumCommentPages: number | null;
    maximumKudosPages: number | null;
    maximumBookmarkPages: number | null;
  };
}

export type Completion =
  | { status: "succeeded" }
  | { status: "not_found"; code: string; message: string }
  | { status: "terminal_failed"; code: string; message: string }
  | { status: "retryable_failed"; code: string; message: string; availableAt: Date }
  | { status: "cancelled"; message?: string };

export class TaskLeaseStore {
  private readonly stalledReports = new Map<number, number>();

  constructor(private readonly db: CollectorDatabase, private readonly events?: EventLog) {}

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
      captureComments: sources.captureComments,
      captureKudos: sources.captureKudos,
      captureBookmarks: sources.captureBookmarks,
      maximumCommentPages: sources.maximumCommentPages,
      maximumKudosPages: sources.maximumKudosPages,
      maximumBookmarkPages: sources.maximumBookmarkPages,
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
        captureComments: row.captureComments,
        captureKudos: row.captureKudos,
        captureBookmarks: row.captureBookmarks,
        maximumCommentPages: row.maximumCommentPages,
        maximumKudosPages: row.maximumKudosPages,
        maximumBookmarkPages: row.maximumBookmarkPages,
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
      lastErrorCode: completion.status === "terminal_failed" || completion.status === "retryable_failed" || completion.status === "not_found" ? completion.code : null,
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

  /**
   * Requeue planning for any job whose planning lease expired. A planning
   * lease is only refreshed by the planner process, so if the planner dies
   * mid-planning a job can sit with a stale lease forever. This watchdog kick
   * makes planning re-claimable regardless of whether the planner is alive.
   */
  async reclaimExpiredPlanning(now = new Date()): Promise<number> {
    const result = await this.db.execute(sql`
      UPDATE collection_jobs
      SET planning_status = 'queued',
          planning_lease_token = NULL,
          planning_lease_expires_at = NULL,
          planning_error = NULL,
          updated_at = ${now}
      WHERE planning_status IN ('planning', 'leased')
        AND planning_lease_expires_at <= ${now}
        AND status IN ('queued', 'running')
    `);
    const reclaimed = affectedRows(result);
    if (reclaimed > 0) {
      await this.events?.record({
        level: "warn",
        event: "planning_reclaimed",
        message: `Requeued ${reclaimed} job(s) whose planning lease expired (planner interrupted).`,
        context: { reclaimed },
      });
    }
    return reclaimed;
  }

  /**
   * Detect jobs that are queued/running but have not made progress within the
   * threshold, classify why, and emit a job_stalled event (deduplicated per
   * job so it is not re-reported until the threshold elapses again).
   */
  async detectStalledJobs(now = new Date(), thresholdMs = 30 * 60_000): Promise<void> {
    const staleBefore = new Date(now.getTime() - thresholdMs);
    const candidates = await this.db.select({
      id: collectionJobs.id,
      sourceId: collectionJobs.sourceId,
      status: collectionJobs.status,
      planningStatus: collectionJobs.planningStatus,
      updatedAt: collectionJobs.updatedAt,
    }).from(collectionJobs).where(and(
      inArray(collectionJobs.status, ["queued", "running"]),
      sql`${collectionJobs.updatedAt} <= ${staleBefore}`,
    )).limit(200);

    for (const job of candidates) {
      const reason = await this.classifyStall(job, now);
      if (!reason) continue;
      const lastReported = this.stalledReports.get(job.id);
      if (lastReported && now.getTime() - lastReported < thresholdMs) continue;
      this.stalledReports.set(job.id, now.getTime());
      await this.events?.record({
        level: "warn",
        event: "job_stalled",
        message: `Job #${job.id} has not made progress in ${Math.round(thresholdMs / 60_000)}m: ${reason}.`,
        context: { jobId: job.id, status: job.status, planningStatus: job.planningStatus, reason, lastActivity: job.updatedAt },
      });
    }
  }

  private async classifyStall(
    job: { id: number; sourceId: number; status: string; planningStatus: string; updatedAt: Date },
    now: Date,
  ): Promise<string | null> {
    const source = (await this.db.select({ paused: sources.paused }).from(sources).where(eq(sources.id, job.sourceId)).limit(1))[0];
    if (source?.paused) return "source_paused";
    if (job.planningStatus !== "completed") return "planning_stalled";
    const anyPending = (await this.db.select({ id: collectionTasks.id }).from(collectionTasks).where(and(
      eq(collectionTasks.jobId, job.id),
      inArray(collectionTasks.status, ["queued", "retryable_failed"]),
    )).limit(1)).length > 0;
    if (!anyPending) return null;
    const anyClaimable = (await this.db.select({ id: collectionTasks.id }).from(collectionTasks).where(and(
      eq(collectionTasks.jobId, job.id),
      inArray(collectionTasks.status, ["queued", "retryable_failed"]),
      sql`${collectionTasks.availableAt} <= ${now}`,
    )).limit(1)).length > 0;
    return anyClaimable ? "worker_stalled" : "retry_backoff";
  }

  /**
   * Self-heal jobs whose status became 'cancelled' while they still have
   * queued or retryable tasks, or whose planning was interrupted mid-lease.
   * A genuine operator cancel cancels those tasks and marks planning
   * completed, so only the corrupted state (cancelled + pending work) or a
   * stuck planning lease is flipped back to running.
   */
  async recoverCancelledJobs(now = new Date()): Promise<number> {
    const result = await this.db.execute(sql`
      UPDATE collection_jobs AS job
      SET job.status = 'running',
          job.completed_at = NULL,
          job.planning_status = CASE
            WHEN job.planning_status = 'completed' THEN 'completed'
            ELSE 'queued'
          END,
          job.planning_error = NULL,
          job.updated_at = ${now}
      WHERE job.status = 'cancelled'
        AND (
          job.planning_status IN ('planning', 'leased')
          OR EXISTS (
            SELECT 1 FROM collection_tasks
            WHERE job_id = job.id AND status IN ('queued', 'retryable_failed')
          )
        )
    `);
    const recovered = affectedRows(result);
    if (recovered > 0) {
      await this.events?.record({
        level: "warn",
        event: "job_self_healed",
        message: `Recovered ${recovered} cancelled job(s) that still had pending work or an interrupted planning lease.`,
        context: { recovered },
      });
    }
    return recovered;
  }

  async pauseJob(jobId: number): Promise<void> {
    await withDatabaseRetry(async () => {
      const now = new Date();
      await this.db.transaction(async (tx) => {
        const job = (await tx.select({ planningStatus: collectionJobs.planningStatus }).from(collectionJobs)
          .where(and(eq(collectionJobs.id, jobId), inArray(collectionJobs.status, ["queued", "running"]))).limit(1).for("update"))[0];
        if (!job) return;
        await tx.update(collectionJobs).set({ status: "paused", updatedAt: now }).where(eq(collectionJobs.id, jobId));
        if (job.planningStatus === "leased" || job.planningStatus === "planning") {
          await tx.update(collectionJobs).set({
            planningStatus: "queued", planningLeaseToken: null, planningLeaseExpiresAt: null, updatedAt: now,
          }).where(eq(collectionJobs.id, jobId));
        }
      });
    });
  }

  async resumeJob(jobId: number): Promise<void> {
    await this.db.update(collectionJobs).set({ status: "running", updatedAt: new Date() }).where(eq(collectionJobs.id, jobId));
  }

  async retryFailures(jobId: number): Promise<void> {
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.update(collectionTasks).set({
        status: "queued", attempts: 0, availableAt: now, leaseExpiresAt: null, leasedBy: null,
        lastErrorCode: null, lastErrorMessage: null, updatedAt: now,
      }).where(and(eq(collectionTasks.jobId, jobId), eq(collectionTasks.status, "terminal_failed")));
      await tx.update(collectionJobs).set({ status: "running", completedAt: null, updatedAt: now })
        .where(and(eq(collectionJobs.id, jobId), inArray(collectionJobs.status, ["completed", "failed", "paused", "running"])));
    });
  }

  async cancelJob(jobId: number): Promise<void> {
    await withDatabaseRetry(async () => {
      const now = new Date();
      await this.db.transaction(async (tx) => {
        await tx.update(collectionJobs).set({
          status: "cancelled", planningStatus: "completed", planningLeaseToken: null,
          planningLeaseExpiresAt: null, completedAt: now, updatedAt: now,
        }).where(eq(collectionJobs.id, jobId));
        await tx.update(collectionTasks).set({ status: "cancelled", leaseExpiresAt: null, leasedBy: null, updatedAt: now })
          .where(and(eq(collectionTasks.jobId, jobId), inArray(collectionTasks.status, ["queued", "retryable_failed"])));
      });
    });
  }

  private async recomputeJob(jobId: number, now: Date): Promise<void> {
    await this.db.execute(sql`
      UPDATE collection_jobs AS job
      SET job.succeeded_count = (SELECT COUNT(*) FROM collection_tasks WHERE job_id = ${jobId} AND status = 'succeeded'),
          job.failed_count = (SELECT COUNT(*) FROM collection_tasks WHERE job_id = ${jobId} AND status = 'terminal_failed'),
          job.skipped_count = (SELECT COUNT(*) FROM collection_tasks WHERE job_id = ${jobId} AND status IN ('cancelled', 'not_found')),
          job.status = CASE
            WHEN job.status = 'cancelled' AND NOT EXISTS (
              SELECT 1 FROM collection_tasks
              WHERE job_id = ${jobId} AND status IN ('queued', 'leased', 'retryable_failed')
            ) THEN 'cancelled'
            WHEN NOT EXISTS (
              SELECT 1 FROM collection_tasks
              WHERE job_id = ${jobId} AND status IN ('queued', 'leased', 'retryable_failed')
            ) THEN 'completed'
            WHEN job.status = 'cancelled' THEN 'running'
            ELSE job.status
          END,
          job.completed_at = CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM collection_tasks
              WHERE job_id = ${jobId} AND status IN ('queued', 'leased', 'retryable_failed')
            ) THEN ${now}
            ELSE NULL
          END,
          job.updated_at = ${now}
      WHERE job.id = ${jobId}
    `);
  }
}

async function withDatabaseRetry<T>(operation: () => Promise<T>, maximumAttempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maximumAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isTransientLockError(error) || attempt === maximumAttempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 75));
    }
  }
  throw lastError;
}

function isTransientLockError(error: unknown): boolean {
  let candidate: unknown = error;
  for (let depth = 0; depth < 4 && candidate && typeof candidate === "object"; depth += 1) {
    const code = "code" in candidate ? String((candidate as { code?: unknown }).code ?? "") : "";
    if (["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "1213", "1205"].includes(code)) return true;
    candidate = "cause" in candidate ? (candidate as { cause?: unknown }).cause : null;
  }
  return false;
}

function affectedRows(result: unknown): number {
  const candidate = Array.isArray(result) ? result[0] : result;
  if (candidate && typeof candidate === "object" && "affectedRows" in candidate) {
    return Number((candidate as { affectedRows: unknown }).affectedRows);
  }
  return 0;
}
