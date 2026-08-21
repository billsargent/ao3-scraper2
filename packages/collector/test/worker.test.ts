import { describe, expect, it, vi } from "vitest";
import {
  CollectorWorker,
  retryDelay,
  type WorkerBudgetOperations,
  type WorkerLeaseOperations,
  type WorkProcessorFactory,
} from "../src/worker.js";
import type { ClaimedTask } from "../src/task-store.js";

function task(attempts = 1): ClaimedTask {
  return {
    taskId: 1,
    jobId: 2,
    sourceWorkId: "12345",
    attempts,
    leaseToken: "worker:token",
    leaseExpiresAt: new Date("2026-08-17T12:02:00Z"),
    source: {
      id: 3, origin: "https://archiveofourown.org", userAgent: "Mozilla/5.0 Chrome/140.0.0.0",
      includeAdult: true, minimumDelayMs: 10_000, dailyRequestBudget: 250,
      dailyByteBudget: 1_073_741_824, requestTimeoutMs: 60_000,
      maximumResponseBytes: 20_971_520, maximumFailureAttempts: 6,
    },
  };
}

function dependencies(claimed: ClaimedTask | undefined = task()) {
  const leases = {
    claim: vi.fn().mockResolvedValue(claimed ? [claimed] : []),
    heartbeat: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(true),
    defer: vi.fn().mockResolvedValue(true),
    reclaimExpired: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkerLeaseOperations;
  const budgets = {
    reserveRequest: vi.fn().mockResolvedValue({
      granted: true, reservedAt: new Date("2026-08-17T12:00:00Z"),
      nextRequestAt: new Date("2026-08-17T12:00:10Z"), remainingToday: 249,
    }),
    recordResponseBytes: vi.fn().mockResolvedValue(undefined),
  } as unknown as WorkerBudgetOperations;
  const processor = { process: vi.fn().mockResolvedValue({
    status: "succeeded", localWorkId: 10, contentHash: `sha256:${"a".repeat(64)}`, responseBytes: 123,
  }) };
  const processors = { create: vi.fn().mockReturnValue(processor) } as unknown as WorkProcessorFactory;
  return { leases, budgets, processor, processors };
}

describe("CollectorWorker", () => {
  it("reserves a source slot, processes a task, records bytes, and completes it", async () => {
    const { leases, budgets, processor, processors } = dependencies();
    const worker = new CollectorWorker(leases, budgets, processors, {
      workerId: "test-worker", heartbeatMilliseconds: 1_000_000,
    });
    expect(await worker.processOne()).toBe(true);
    expect(processor.process).toHaveBeenCalledWith("12345");
    expect(budgets.recordResponseBytes).toHaveBeenCalledWith(3, 123, expect.any(Date));
    expect(leases.complete).toHaveBeenCalledWith(1, "worker:token", { status: "succeeded" });
  });

  it("heartbeats and waits for a short distributed delay instead of releasing the task", async () => {
    let now = new Date("2026-08-17T12:00:00Z");
    const sleep = vi.fn(async (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); });
    const { leases, budgets, processors } = dependencies();
    vi.mocked(budgets.reserveRequest)
      .mockResolvedValueOnce({ granted: false, reason: "delay", retryAt: new Date("2026-08-17T12:00:10Z") })
      .mockResolvedValueOnce({ granted: true, reservedAt: new Date("2026-08-17T12:00:10Z"), nextRequestAt: new Date("2026-08-17T12:00:20Z"), remainingToday: 10 });
    const worker = new CollectorWorker(leases, budgets, processors, {
      workerId: "test-worker", now: () => now, sleep, heartbeatMilliseconds: 1_000_000,
    });
    await worker.processOne();
    expect(sleep).toHaveBeenCalledWith(10_000);
    expect(leases.heartbeat).toHaveBeenCalled();
    expect(leases.defer).not.toHaveBeenCalled();
  });

  it("defers a task until the next day when the daily budget is exhausted", async () => {
    const { leases, budgets, processors } = dependencies();
    const retryAt = new Date("2026-08-18T00:00:00Z");
    vi.mocked(budgets.reserveRequest).mockResolvedValue({ granted: false, reason: "daily_budget", retryAt });
    const worker = new CollectorWorker(leases, budgets, processors, { workerId: "test-worker" });
    await worker.processOne();
    expect(leases.defer).toHaveBeenCalledWith(1, "worker:token", retryAt, "source_daily_budget");
    expect(processors.create).not.toHaveBeenCalled();
  });

  it("schedules retryable failures and eventually makes them terminal", async () => {
    const first = dependencies(task(2));
    first.processor.process.mockResolvedValue({ status: "retryable_failed", code: "http_525", message: "temporary", responseBytes: 0 });
    const worker = new CollectorWorker(first.leases, first.budgets, first.processors, {
      workerId: "test-worker", now: () => new Date("2026-08-17T12:00:00Z"), random: () => 0.5,
    });
    await worker.processOne();
    expect(first.leases.complete).toHaveBeenCalledWith(1, "worker:token", {
      status: "retryable_failed", code: "http_525", message: "temporary", availableAt: new Date("2026-08-17T12:02:00Z"),
    });

    const exhausted = dependencies(task(6));
    exhausted.processor.process.mockResolvedValue({ status: "retryable_failed", code: "http_525", message: "temporary", responseBytes: 0 });
    await new CollectorWorker(exhausted.leases, exhausted.budgets, exhausted.processors, {
      workerId: "test-worker", maximumFailureAttempts: 6,
    }).processOne();
    expect(exhausted.leases.complete).toHaveBeenCalledWith(1, "worker:token", {
      status: "terminal_failed", code: "retry_exhausted", message: "http_525: temporary",
    });
  });

  it("uses bounded exponential retry delay with jitter", () => {
    expect(retryDelay(1, () => 0.5)).toBe(60_000);
    expect(retryDelay(2, () => 0.5)).toBe(120_000);
    expect(retryDelay(20, () => 0.5)).toBe(21_600_000);
  });

  it("survives a transient DB error in the run loop without crashing", async () => {
    const { leases, budgets, processors } = dependencies(undefined);
    const claim = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("Lock wait timeout exceeded"), { code: "ER_LOCK_WAIT_TIMEOUT" }))
      .mockResolvedValueOnce([]);
    leases.claim = claim;
    const controller = new AbortController();
    const worker = new CollectorWorker(leases, budgets, processors, {
      workerId: "test-worker",
      sleep: async () => { controller.abort(); },
    });
    await worker.run(controller.signal);
    expect(claim).toHaveBeenCalledTimes(1);
  });
});
