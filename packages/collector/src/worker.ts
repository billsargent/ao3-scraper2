import type { TaskOutcome } from "./processor.js";
import type { RequestReservation, SourceBudgetStore } from "./source-budget-store.js";
import type { ClaimedTask, TaskLeaseStore } from "./task-store.js";
import type { EventLog } from "./event-log.js";

export interface WorkProcessor {
  process(sourceWorkId: string): Promise<TaskOutcome>;
}

export interface WorkProcessorFactory {
  create(task: ClaimedTask): WorkProcessor;
}

export interface WorkerOptions {
  workerId: string;
  leaseMilliseconds?: number;
  heartbeatMilliseconds?: number;
  idleMilliseconds?: number;
  maximumFailureAttempts?: number;
  events?: EventLog;
  watchdog?: (now: Date) => Promise<void>;
  autoFill?: (now: Date) => Promise<void>;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => Date;
  random?: () => number;
}

export type WorkerLeaseOperations = Pick<TaskLeaseStore, "claim" | "heartbeat" | "complete" | "defer" | "reclaimExpired" | "recoverCancelledJobs">;
export type WorkerBudgetOperations = Pick<SourceBudgetStore, "reserveRequest" | "recordResponseBytes">;

export class CollectorWorker {
  private readonly leaseMilliseconds: number;
  private readonly heartbeatMilliseconds: number;
  private readonly idleMilliseconds: number;
  private readonly maximumFailureAttempts: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => Date;
  private readonly random: () => number;

  constructor(
    private readonly leases: WorkerLeaseOperations,
    private readonly budgets: WorkerBudgetOperations,
    private readonly processors: WorkProcessorFactory,
    private readonly options: WorkerOptions,
  ) {
    if (!options.workerId.trim()) throw new Error("workerId is required");
    this.leaseMilliseconds = options.leaseMilliseconds ?? 120_000;
    this.heartbeatMilliseconds = options.heartbeatMilliseconds ?? 30_000;
    this.idleMilliseconds = options.idleMilliseconds ?? 2_000;
    this.maximumFailureAttempts = options.maximumFailureAttempts ?? 6;
    this.sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.now = options.now ?? (() => new Date());
    this.random = options.random ?? Math.random;
  }

  async processOne(): Promise<boolean> {
    const task = (await this.leases.claim(this.options.workerId, 1, this.leaseMilliseconds))[0];
    if (!task) return false;

    const reservation = await this.waitForRequestReservation(task);
    if (!reservation.granted) {
      const retryAt = reservation.retryAt ?? new Date(this.now().getTime() + 60_000);
      await this.leases.defer(task.taskId, task.leaseToken, retryAt, `source_${reservation.reason}`);
      await this.options.events?.record({
        level: "info",
        event: "collector_deferred",
        message: `Deferred AO3 #${task.sourceWorkId}: ${reservation.reason}.`,
        context: { taskId: task.taskId, jobId: task.jobId, sourceWorkId: task.sourceWorkId, reason: reservation.reason },
      });
      return true;
    }

    const outcome = await this.processWithHeartbeat(task);
    if (outcome.responseBytes > 0) {
      await this.budgets.recordResponseBytes(task.source.id, outcome.responseBytes, this.now());
    }
    if (outcome.status === "succeeded") {
      await this.leases.complete(task.taskId, task.leaseToken, { status: "succeeded" });
    } else if (outcome.status === "not_found") {
      await this.leases.complete(task.taskId, task.leaseToken, { status: "not_found", code: outcome.code, message: outcome.message });
    } else if (outcome.status === "terminal_failed") {
      await this.leases.complete(task.taskId, task.leaseToken, outcome);
    } else if ((task.source.maximumFailureAttempts ?? this.maximumFailureAttempts) > 0 && task.attempts >= (task.source.maximumFailureAttempts ?? this.maximumFailureAttempts)) {
      await this.leases.complete(task.taskId, task.leaseToken, {
        status: "terminal_failed",
        code: "retry_exhausted",
        message: `${outcome.code}: ${outcome.message}`,
      });
    } else {
      await this.leases.complete(task.taskId, task.leaseToken, {
        status: "retryable_failed",
        code: outcome.code,
        message: outcome.message,
        availableAt: new Date(this.now().getTime() + retryDelay(task.attempts, this.random)),
      });
    }
    const level = outcome.status === "succeeded" ? "debug" : outcome.status === "not_found" ? "info" : "warn";
    const outcomeCode = "code" in outcome ? outcome.code : null;
    const outcomeMessage = "message" in outcome ? outcome.message : null;
    await this.options.events?.record({
      level,
      event: `collector_${outcome.status}`,
      message: `AO3 #${task.sourceWorkId} finished as ${outcome.status}${outcomeCode ? ` (${outcomeCode})` : ""}.`,
      context: {
        taskId: task.taskId,
        jobId: task.jobId,
        sourceWorkId: task.sourceWorkId,
        attempts: task.attempts,
        code: outcomeCode,
        message: outcomeMessage,
      },
    });
    return true;
  }

  async run(signal: AbortSignal): Promise<void> {
    await this.safe(() => this.leases.reclaimExpired(this.now()), "reclaim_expired");
    let cycles = 0;
    let lastWatchdog = 0;
    let lastAutoFill = 0;
    while (!signal.aborted) {
      try {
        const processed = await this.processOne();
        if (!processed && !signal.aborted) await this.sleep(this.idleMilliseconds);
      } catch (error) {
        // A transient DB error (deadlock/lock-wait) must never kill the worker.
        // Log it and continue; the lease machinery re-queues any task that was
        // in flight, and reclaimExpired cleans up later.
        await this.logWorkerError("collector_error", error);
        if (!signal.aborted) await this.sleep(2_000);
      }
      cycles += 1;
      // Periodically heal jobs whose status was corrupted to 'cancelled'
      // while they still have pending tasks (see recoverCancelledJobs).
      if (cycles % 10 === 0 && !signal.aborted) {
        await this.safe(() => this.leases.reclaimExpired(this.now()), "reclaim_expired");
        await this.safe(() => this.leases.recoverCancelledJobs(this.now()), "recover_cancelled");
      }
      const nowMs = this.now().getTime();
      // Time-based maintenance: stale-job watchdog and auto-fill kick in every
      // ~10 minutes regardless of how many cycles ran.
      if (this.options.watchdog && nowMs - lastWatchdog >= 10 * 60_000 && !signal.aborted) {
        lastWatchdog = nowMs;
        await this.safe(() => this.options.watchdog!(this.now()), "watchdog");
      }
      if (this.options.autoFill && nowMs - lastAutoFill >= 10 * 60_000 && !signal.aborted) {
        lastAutoFill = nowMs;
        await this.safe(() => this.options.autoFill!(this.now()), "auto_fill");
      }
    }
  }

  private async safe(operation: () => Promise<unknown>, event: string): Promise<void> {
    try {
      await operation();
    } catch (error) {
      await this.logWorkerError(`worker_${event}_failed`, error);
    }
  }

  private async logWorkerError(event: string, error: unknown): Promise<void> {
    await this.options.events?.record({
      level: "error",
      event,
      message: error instanceof Error ? error.message : String(error),
      context: { workerId: this.options.workerId, error: error instanceof Error ? error.stack ?? error.message : String(error) },
    });
  }

  private async waitForRequestReservation(task: ClaimedTask): Promise<RequestReservation> {
    while (true) {
      const reservation = await this.budgets.reserveRequest(task.source.id, this.now());
      if (reservation.granted || reservation.reason !== "delay" || !reservation.retryAt) return reservation;
      const wait = Math.max(0, reservation.retryAt.getTime() - this.now().getTime());
      if (wait > 0) {
        const heartbeatOk = await this.leases.heartbeat(task.taskId, task.leaseToken, this.leaseMilliseconds);
        if (!heartbeatOk) return { granted: false, reason: "paused", retryAt: null };
        await this.sleep(wait);
      }
    }
  }

  private async processWithHeartbeat(task: ClaimedTask): Promise<TaskOutcome> {
    const timer = setInterval(() => {
      void this.leases.heartbeat(task.taskId, task.leaseToken, this.leaseMilliseconds);
    }, this.heartbeatMilliseconds);
    timer.unref();
    try {
      return await this.processors.create(task).process(task.sourceWorkId);
    } finally {
      clearInterval(timer);
    }
  }
}

export function retryDelay(attempt: number, random = Math.random): number {
  const base = Math.min(6 * 60 * 60_000, Math.max(60_000, 2 ** Math.max(0, attempt - 1) * 60_000));
  return Math.round(base * (0.8 + random() * 0.4));
}
