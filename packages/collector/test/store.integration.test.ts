import { createServer } from "node:http";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { and, count, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  authors,
  chapters,
  collectionJobs,
  collectionTasks,
  createDatabase,
  exportRuns,
  fetchSnapshots,
  observations,
  series,
  seriesWorks,
  sourceDailyUsage,
  sources,
  tags,
  workAuthors,
  works,
  workTags,
  type CollectorDatabase,
} from "@ao3-offsite/database";
import { readTransferPackage } from "@ao3-offsite/package-tools";
import { parseEntireWorkHtml, PoliteSourceClient } from "@ao3-offsite/scraper-core";
import { ContentAddressedBlobStore } from "../src/blob-store.js";
import { AutoFillStore } from "../src/auto-fill.js";
import { ExportQueueStore } from "../src/export-queue.js";
import { ExportWorker } from "../src/export-worker.js";
import { MariaDbPackageExporter } from "../src/exporter.js";
import { JobPlannerStore, JobPlannerWorker } from "../src/job-planner.js";
import { WorkTaskProcessor } from "../src/processor.js";
import { SourceBudgetStore } from "../src/source-budget-store.js";
import { CollectorStore } from "../src/store.js";
import { TaskLeaseStore } from "../src/task-store.js";
import { CollectorWorker } from "../src/worker.js";
import type { EventLog } from "../src/event-log.js";

const fixtureUrl = new URL("../../scraper-core/test/fixtures/work-entire.html", import.meta.url);
const databaseUrl = process.env.COLLECTOR_DATABASE_URL;

function firstCount(rows: Array<{ value: number }>): number {
  return rows[0]?.value ?? 0;
}

const integration = describe.runIf(Boolean(databaseUrl));

integration("CollectorStore with MariaDB", () => {
  let db: CollectorDatabase;
  let pool: ReturnType<typeof createDatabase>["pool"];
  let store: CollectorStore;
  let leases: TaskLeaseStore;
  let budgets: SourceBudgetStore;
  let sourceId: number;

  beforeAll(async () => {
    ({ db, pool } = createDatabase(databaseUrl));
    for (const table of [fetchSnapshots, observations, seriesWorks, series, workTags, tags, chapters, workAuthors, authors, exportRuns, works, collectionTasks, collectionJobs, sourceDailyUsage, sources]) {
      await db.delete(table);
    }
    sourceId = (await db.insert(sources).values({
      key: "integration-test",
      origin: "https://archiveofourown.org",
      minimumDelayMs: 5000,
    }).$returningId())[0]!.id;
    store = new CollectorStore(db);
    leases = new TaskLeaseStore(db);
    budgets = new SourceBudgetStore(db);
  });

  beforeEach(async () => {
    for (const table of [fetchSnapshots, observations, seriesWorks, series, workTags, tags, chapters, workAuthors, authors, exportRuns, works, collectionTasks, collectionJobs, sourceDailyUsage]) {
      await db.delete(table);
    }
    await db.update(sources).set({
      paused: false, origin: "https://archiveofourown.org", minimumDelayMs: 5000,
      dailyRequestBudget: 250, dailyByteBudget: 1_073_741_824, nextRequestAt: null,
      operatingWindowStartHourUtc: null, operatingWindowEndHourUtc: null,
      includeAdult: true, requestTimeoutMs: 60_000, maximumResponseBytes: 20_971_520,
      maximumFailureAttempts: 6,
      exportLeaseToken: null, exportLeaseExpiresAt: null, nextExportSequence: 1,
    })
      .where(eq(sources.id, sourceId));
  });

  afterAll(async () => {
    await pool?.end();
  });

  it("creates durable tasks idempotently", async () => {
    const jobId = await store.createIdRangeJob(sourceId, { start: 1, end: 3, batchSize: 2 });
    await store.enqueueWorkIds(jobId, ["1", "2"]);
    await store.enqueueWorkIds(jobId, ["2", "3"]);

    expect(firstCount(await db.select({ value: count() }).from(collectionTasks).where(eq(collectionTasks.jobId, jobId)))).toBe(3);
    expect((await db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)))[0]!.discoveredCount).toBe(3);
  });

  it("does not re-enqueue IDs already observed as not_found", async () => {
    await db.insert(observations).values({
      sourceId,
      sourceWorkId: "2",
      observedAt: new Date(),
      availability: "not_found",
      httpStatus: 404,
      sourceUpdatedAt: null,
      contentHash: null,
    });
    const jobId = await store.createIdRangeJob(sourceId, { start: 1, end: 3, batchSize: 3 });
    const planner = new JobPlannerWorker("integration-planner", new JobPlannerStore(db), 30_000);
    expect(await planner.processOne()).toBe(true);
    const taskIds = (await db.select({ sourceWorkId: collectionTasks.sourceWorkId })
      .from(collectionTasks).where(eq(collectionTasks.jobId, jobId))).map((row) => row.sourceWorkId);
    expect(new Set(taskIds)).toEqual(new Set(["1", "3"]));
  });

  it("keeps a multi-task job running through mixed outcomes", async () => {
    await db.update(sources).set({ minimumDelayMs: 0 }).where(eq(sources.id, sourceId));
    const jobId = await store.createIdRangeJob(sourceId, { start: 1, end: 3, batchSize: 3 });
    await store.enqueueWorkIds(jobId, ["1", "2", "3"]);
    const outcomes = {
      "1": { status: "not_found", code: "http_404", message: "gone", responseBytes: 0 },
      "2": { status: "succeeded", localWorkId: 999, contentHash: `sha256:${"f".repeat(64)}`, responseBytes: 10 },
      "3": { status: "not_found", code: "http_404", message: "gone", responseBytes: 0 },
    } as const;
    const worker = new CollectorWorker(leases, budgets, {
      create(claimed) {
        return { process: async (id: string) => outcomes[id as "1" | "2" | "3"]! };
      },
    }, { workerId: "integration-mixed" });

    expect(await worker.processOne()).toBe(true);
    expect(await worker.processOne()).toBe(true);
    expect(await worker.processOne()).toBe(true);
    const job = (await db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)))[0]!;
    expect(job.status).toBe("completed");
    expect(job.succeededCount).toBe(1);
    expect(job.skippedCount).toBe(2);
  }, 15_000);

  it("self-heals a cancelled job that still has queued tasks", async () => {
    await db.update(sources).set({ minimumDelayMs: 0 }).where(eq(sources.id, sourceId));
    const jobId = await store.createIdRangeJob(sourceId, { start: 1, end: 2, batchSize: 2 });
    await store.enqueueWorkIds(jobId, ["1", "2"]);

    const claimed = await leases.claim("self-heal-worker", 1, 30_000);
    expect(claimed).toHaveLength(1);
    // Corrupt the state: cancel the job without cancelling its queued tasks.
    await db.update(collectionJobs).set({ status: "cancelled" }).where(eq(collectionJobs.id, jobId));
    expect((await db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)))[0]!.status).toBe("cancelled");

    await leases.complete(claimed[0]!.taskId, claimed[0]!.leaseToken, { status: "succeeded" });
    expect((await db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)))[0]!.status).toBe("running");
  }, 15_000);

  it("recovers a cancelled job that still has queued tasks, and keeps genuine cancels", async () => {
    const jobId = await store.createIdRangeJob(sourceId, { start: 1, end: 2, batchSize: 2 });
    await store.enqueueWorkIds(jobId, ["1", "2"]);
    await db.update(collectionJobs).set({ status: "cancelled" }).where(eq(collectionJobs.id, jobId));
    await leases.recoverCancelledJobs();
    expect((await db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)))[0]!.status).toBe("running");

    // A genuine cancel (tasks cancelled too) must stay cancelled.
    await db.update(collectionTasks).set({ status: "cancelled" }).where(eq(collectionTasks.jobId, jobId));
    await db.update(collectionJobs).set({ status: "cancelled" }).where(eq(collectionJobs.id, jobId));
    await leases.recoverCancelledJobs();
    expect((await db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)))[0]!.status).toBe("cancelled");
  }, 15_000);

  it("recovers a cancelled job whose planning was interrupted", async () => {
    const jobId = await store.createIdRangeJob(sourceId, { start: 1, end: 2, batchSize: 2 });
    await db.update(collectionJobs).set({ status: "cancelled", planningStatus: "planning" }).where(eq(collectionJobs.id, jobId));
    await leases.recoverCancelledJobs();
    const job = (await db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)))[0]!;
    expect(job.status).toBe("running");
    expect(job.planningStatus).toBe("queued");
  }, 15_000);

  it("does not un-cancel a genuine cancel that has completed_at set", async () => {
    const jobId = await store.createIdRangeJob(sourceId, { start: 1, end: 2, batchSize: 2 });
    await store.enqueueWorkIds(jobId, ["1", "2"]);
    await db.update(collectionJobs).set({ status: "cancelled", planningStatus: "completed", completedAt: new Date() }).where(eq(collectionJobs.id, jobId));
    await leases.recoverCancelledJobs();
    expect((await db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)))[0]!.status).toBe("cancelled");
  }, 15_000);

  it("cancels a job with many tasks in bounded batches", async () => {
    const jobId = await store.createExplicitIdsJob(sourceId, Array.from({ length: 12000 }, (_unused, i) => String(200000 + i)));
    await leases.cancelJob(jobId);
    const counts = await db.select({ status: collectionTasks.status, value: count() }).from(collectionTasks).where(eq(collectionTasks.jobId, jobId)).groupBy(collectionTasks.status);
    expect(counts.find((row) => row.status === "cancelled")?.value ?? 0).toBe(12000);
    const job = (await db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)))[0]!;
    expect(job.status).toBe("cancelled");
    expect(job.completedAt).not.toBeNull();
  }, 15_000);

  it("plans large ID ranges asynchronously and resumes idempotently from a cursor", async () => {
    const plannerQueue = new JobPlannerStore(db);
    const planner = new JobPlannerWorker("integration-planner", plannerQueue, 30_000);
    const jobId = await store.createIdRangeJob(sourceId, { start: 300, end: 306, batchSize: 3 });
    expect(firstCount(await db.select({ value: count() }).from(collectionTasks).where(eq(collectionTasks.jobId, jobId)))).toBe(0);
    expect(await planner.processOne()).toBe(true);
    expect(firstCount(await db.select({ value: count() }).from(collectionTasks).where(eq(collectionTasks.jobId, jobId)))).toBe(7);
    expect((await db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)))[0]).toMatchObject({
      planningStatus: "completed", planningCursor: 307, discoveredCount: 7,
    });

    // Pausing the source must halt planning too (matching the collector).
    const pausedPlanningJobId = await store.createIdRangeJob(sourceId, { start: 100, end: 105, batchSize: 2 });
    await db.update(sources).set({ paused: true }).where(eq(sources.id, sourceId));
    expect(await planner.processOne()).toBe(false);
    const pausedPlanningJob = (await db.select().from(collectionJobs).where(eq(collectionJobs.id, pausedPlanningJobId)))[0]!;
    expect(pausedPlanningJob.planningStatus).toBe("queued");
    await db.update(sources).set({ paused: false }).where(eq(sources.id, sourceId));
    expect(await planner.processOne()).toBe(true);
    expect((await db.select().from(collectionJobs).where(eq(collectionJobs.id, pausedPlanningJobId)))[0]!.planningStatus).toBe("completed");

    const resumedJobId = await store.createIdRangeJob(sourceId, { start: 400, end: 405, batchSize: 2 });
    await store.enqueueWorkIds(resumedJobId, ["400", "401"]);
    await db.update(collectionJobs).set({ planningCursor: 402 }).where(eq(collectionJobs.id, resumedJobId));
    expect(await planner.processOne()).toBe(true);
    expect(firstCount(await db.select({ value: count() }).from(collectionTasks).where(eq(collectionTasks.jobId, resumedJobId)))).toBe(6);
    expect((await db.select().from(collectionJobs).where(eq(collectionJobs.id, resumedJobId)))[0]!.discoveredCount).toBe(6);

    const pausedJobId = await store.createIdRangeJob(sourceId, { start: 450, end: 453, batchSize: 2 });
    const pausedClaim = await plannerQueue.claim("pause-test", 30_000);
    expect(pausedClaim?.id).toBe(pausedJobId);
    await plannerQueue.markPlanning(pausedJobId, pausedClaim!.leaseToken);
    await leases.pauseJob(pausedJobId);
    expect(await plannerQueue.enqueueBatch(pausedJobId, pausedClaim!.leaseToken, ["450"], 451, 30_000)).toBe(false);
    expect((await db.select().from(collectionJobs).where(eq(collectionJobs.id, pausedJobId)))[0]).toMatchObject({ status: "paused", planningStatus: "queued" });
    await leases.resumeJob(pausedJobId);
    expect(await planner.processOne()).toBe(true);
    expect(firstCount(await db.select({ value: count() }).from(collectionTasks).where(eq(collectionTasks.jobId, pausedJobId)))).toBe(4);

    const cancelledJobId = await store.createIdRangeJob(sourceId, { start: 500, end: 999, batchSize: 100 });
    const cancelledClaim = await plannerQueue.claim("cancel-test", 30_000);
    expect(cancelledClaim?.id).toBe(cancelledJobId);
    await plannerQueue.markPlanning(cancelledJobId, cancelledClaim!.leaseToken);
    await leases.cancelJob(cancelledJobId);
    expect(await plannerQueue.enqueueBatch(cancelledJobId, cancelledClaim!.leaseToken, ["500"], 501, 30_000)).toBe(false);
    expect(firstCount(await db.select({ value: count() }).from(collectionTasks).where(eq(collectionTasks.jobId, cancelledJobId)))).toBe(0);
  });

  it("serializes source request slots and enforces daily request and byte budgets", async () => {
    await db.update(sources).set({ minimumDelayMs: 10_000, dailyRequestBudget: 2 }).where(eq(sources.id, sourceId));
    const start = new Date("2026-08-17T00:00:00.000Z");
    const simultaneous = await Promise.all([budgets.reserveRequest(sourceId, start), budgets.reserveRequest(sourceId, start)]);
    expect(simultaneous.filter((reservation) => reservation.granted)).toHaveLength(1);
    expect(simultaneous.find((reservation) => !reservation.granted)).toMatchObject({ reason: "delay" });

    const second = await budgets.reserveRequest(sourceId, new Date(start.getTime() + 10_000));
    expect(second).toMatchObject({ granted: true, remainingToday: 0 });
    const exhausted = await budgets.reserveRequest(sourceId, new Date(start.getTime() + 20_000));
    expect(exhausted).toMatchObject({ granted: false, reason: "daily_budget", retryAt: new Date("2026-08-18T00:00:00.000Z") });

    await budgets.recordResponseBytes(sourceId, 100, start);
    await budgets.recordResponseBytes(sourceId, 200, start);
    const usage = (await db.select().from(sourceDailyUsage).where(eq(sourceDailyUsage.sourceId, sourceId)))[0]!;
    expect(usage).toMatchObject({ requestCount: 2, responseBytes: 300 });
    await db.update(sources).set({ dailyRequestBudget: 100, dailyByteBudget: 250, nextRequestAt: null }).where(eq(sources.id, sourceId));
    expect(await budgets.reserveRequest(sourceId, new Date(start.getTime() + 30_000)))
      .toMatchObject({ granted: false, reason: "daily_byte_budget" });
    await db.update(sources).set({
      dailyByteBudget: 1_000_000, operatingWindowStartHourUtc: 22, operatingWindowEndHourUtc: 6,
    }).where(eq(sources.id, sourceId));
    expect(await budgets.reserveRequest(sourceId, new Date("2026-08-17T12:00:00.000Z")))
      .toMatchObject({ granted: false, reason: "operating_window", retryAt: new Date("2026-08-17T22:00:00.000Z") });

    await db.update(sources).set({ paused: true }).where(eq(sources.id, sourceId));
    expect(await budgets.reserveRequest(sourceId, new Date("2026-08-18T00:00:00.000Z"))).toMatchObject({ granted: false, reason: "paused" });
  });

  it("claims tasks exclusively across workers and verifies lease ownership", async () => {
    const jobId = await store.createIdRangeJob(sourceId, { start: 100, end: 103, batchSize: 4 });
    await store.enqueueWorkIds(jobId, ["100", "101", "102", "103"]);

    const workerA = await leases.claim("worker-a", 2, 30_000);
    const workerB = await leases.claim("worker-b", 2, 30_000);
    const workerC = await leases.claim("worker-c", 2, 30_000);
    expect(workerA).toHaveLength(2);
    expect(workerB).toHaveLength(2);
    expect(workerC).toHaveLength(0);
    expect(new Set([...workerA, ...workerB].map((task) => task.taskId)).size).toBe(4);
    expect(await leases.heartbeat(workerA[0]!.taskId, "wrong-token", 30_000)).toBe(false);
    expect(await leases.heartbeat(workerA[0]!.taskId, workerA[0]!.leaseToken, 30_000)).toBe(true);

    expect(await leases.complete(workerA[0]!.taskId, workerA[0]!.leaseToken, { status: "succeeded" })).toBe(true);
    expect(await leases.complete(workerA[1]!.taskId, workerA[1]!.leaseToken, {
      status: "terminal_failed", code: "not_found", message: "Not found",
    })).toBe(true);
    expect(await leases.complete(workerB[0]!.taskId, workerB[0]!.leaseToken, { status: "succeeded" })).toBe(true);
    expect(await leases.complete(workerB[1]!.taskId, workerB[1]!.leaseToken, { status: "succeeded" })).toBe(true);

    const job = (await db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)))[0]!;
    expect(job).toMatchObject({ status: "completed", succeededCount: 3, failedCount: 1 });
    await leases.retryFailures(jobId);
    const retried = (await db.select().from(collectionTasks).where(and(
      eq(collectionTasks.jobId, jobId), eq(collectionTasks.sourceWorkId, workerA[1]!.sourceWorkId),
    )))[0]!;
    expect(retried).toMatchObject({ status: "queued", attempts: 0, lastErrorCode: null });
    expect((await db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)))[0]!.status).toBe("running");
  });

  it("counts not-found completions as skipped and never retries them", async () => {
    const jobId = await store.createIdRangeJob(sourceId, { start: 300, end: 301, batchSize: 2 });
    await store.enqueueWorkIds(jobId, ["300", "301"]);

    const claimed = await leases.claim("worker-a", 2, 30_000);
    expect(claimed).toHaveLength(2);
    await leases.complete(claimed[0]!.taskId, claimed[0]!.leaseToken, { status: "succeeded" });
    await leases.complete(claimed[1]!.taskId, claimed[1]!.leaseToken, { status: "not_found", code: "http_404", message: "not found" });

    const job = (await db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)))[0]!;
    expect(job).toMatchObject({ status: "completed", succeededCount: 1, failedCount: 0, skippedCount: 1 });

    await leases.retryFailures(jobId);
    const tasks = await db.select().from(collectionTasks).where(eq(collectionTasks.jobId, jobId));
    expect(tasks.map((task) => task.status).sort()).toEqual(["not_found", "succeeded"]);
  });

  it("reclaims expired leases and respects pause, resume, and cancel", async () => {
    const jobId = await store.createIdRangeJob(sourceId, { start: 200, end: 201, batchSize: 2 });
    await store.enqueueWorkIds(jobId, ["200", "201"]);
    await leases.pauseJob(jobId);
    expect(await leases.claim("paused-worker", 2, 30_000)).toHaveLength(0);
    await leases.resumeJob(jobId);
    const claimed = await leases.claim("lost-worker", 1, 10_000);
    expect(claimed).toHaveLength(1);

    await db.update(collectionTasks).set({ leaseExpiresAt: new Date(Date.now() - 1000) })
      .where(eq(collectionTasks.id, claimed[0]!.taskId));
    await leases.reclaimExpired();
    expect((await db.select({ attempts: collectionTasks.attempts }).from(collectionTasks)
      .where(eq(collectionTasks.id, claimed[0]!.taskId)))[0]!.attempts).toBe(1);
    const replacementClaims = await leases.claim("replacement-worker", 2, 30_000);
    const reclaimed = replacementClaims.find((task) => task.taskId === claimed[0]!.taskId);
    expect(reclaimed).toBeDefined();
    expect((await db.select({ attempts: collectionTasks.attempts }).from(collectionTasks)
      .where(eq(collectionTasks.id, claimed[0]!.taskId)))[0]!.attempts).toBe(2);
    expect(reclaimed!.attempts).toBe(2);

    await leases.cancelJob(jobId);
    expect((await db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)))[0]!.status).toBe("cancelled");
    expect(await leases.claim("after-cancel", 10, 30_000)).toHaveLength(0);
  });

  it("recovers an expired export with the same package and sequence", async () => {
    const root = await mkdtemp(join(tmpdir(), "ao3-export-recovery-"));
    try {
      const queue = new ExportQueueStore(db);
      const request = await queue.createRequest(sourceId, root, 10);
      const first = await queue.claim("crashed-worker", 30_000);
      expect(first).toMatchObject({ id: request.id, packageId: request.packageId, sequenceNumber: 1 });
      await queue.markWriting(first!.id, first!.leaseToken);
      const expired = new Date(Date.now() - 1_000);
      await db.update(exportRuns).set({ leaseExpiresAt: expired }).where(eq(exportRuns.id, first!.id));
      await db.update(sources).set({ exportLeaseExpiresAt: expired }).where(eq(sources.id, sourceId));
      const recovered = await queue.claim("replacement-worker", 30_000);
      expect(recovered).toMatchObject({
        id: first!.id,
        packageId: first!.packageId,
        sequenceNumber: first!.sequenceNumber,
        previousPackageId: first!.previousPackageId,
      });
      await queue.markFailed(recovered!.id, recovered!.leaseToken, new Error("test cleanup"));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("allows export workers to claim different sources concurrently", async () => {
    const otherSourceId = (await db.insert(sources).values({
      key: "second-export-source", origin: "https://example.org", paused: true,
    }).$returningId())[0]!.id;
    const root = await mkdtemp(join(tmpdir(), "ao3-export-claims-"));
    try {
      const queue = new ExportQueueStore(db);
      await queue.createRequest(sourceId, root, 10);
      await queue.createRequest(otherSourceId, root, 10);
      const [first, second] = await Promise.all([
        queue.claim("parallel-a", 30_000), queue.claim("parallel-b", 30_000),
      ]);
      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(new Set([first!.sourceId, second!.sourceId]).size).toBe(2);
      expect(first!.sequenceNumber).toBe(1);
      expect(second!.sequenceNumber).toBe(1);
      await queue.markFailed(first!.id, first!.leaseToken, new Error("test cleanup"));
      await queue.markFailed(second!.id, second!.leaseToken, new Error("test cleanup"));
    } finally {
      await db.delete(exportRuns).where(eq(exportRuns.sourceId, otherSourceId));
      await db.delete(sources).where(eq(sources.id, otherSourceId));
      await rm(root, { recursive: true, force: true });
    }
  });

  it("runs a leased task end to end against a local fixture source", async () => {
    const html = await readFile(fileURLToPath(fixtureUrl), "utf8");
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(html);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const blobDirectory = await mkdtemp(join(tmpdir(), "ao3-worker-blobs-"));
    try {
      await db.update(sources).set({ origin, minimumDelayMs: 2000, dailyRequestBudget: 10 })
        .where(eq(sources.id, sourceId));
      const jobId = await store.createIdRangeJob(sourceId, { start: 12345, end: 12345, batchSize: 1 });
      await store.enqueueWorkIds(jobId, ["12345"]);
      const worker = new CollectorWorker(leases, budgets, {
        create(claimed) {
          return new WorkTaskProcessor(
            { id: claimed.source.id, origin: claimed.source.origin, includeAdult: true },
            new PoliteSourceClient({
              origin: claimed.source.origin,
              userAgent: "AO3-Offsite-Integration-Test/0.1",
              minimumDelayMs: claimed.source.minimumDelayMs,
              maximumAttempts: 1,
            }),
            new ContentAddressedBlobStore(blobDirectory),
            store,
          );
        },
      }, { workerId: "integration-worker", heartbeatMilliseconds: 1_000_000 });

      expect(await worker.processOne()).toBe(true);
      expect((await db.select().from(collectionTasks).where(eq(collectionTasks.jobId, jobId)))[0]!.status).toBe("succeeded");
      expect((await db.select().from(works).where(and(eq(works.sourceId, sourceId), eq(works.sourceWorkId, "12345"))))[0]!.title)
        .toBe("Example Work");
      expect(firstCount(await db.select({ value: count() }).from(fetchSnapshots).where(eq(fetchSnapshots.sourceWorkId, "12345")))).toBe(1);
      expect((await db.select().from(sourceDailyUsage).where(eq(sourceDailyUsage.sourceId, sourceId)))[0])
        .toMatchObject({ requestCount: 1, responseBytes: Buffer.byteLength(html) });
    } finally {
      server.close();
      await rm(blobDirectory, { recursive: true, force: true });
    }
  });

  it("upserts and reconciles a normalized work transactionally", async () => {
    const html = await readFile(fileURLToPath(fixtureUrl), "utf8");
    const records = parseEntireWorkHtml(html, {
      sourceUrl: "https://archiveofourown.org/works/12345?view_full_work=true",
      capturedAt: "2026-08-17T12:00:00.000Z",
    });
    records.comments = [{
      operation: "upsert",
      sourceWorkId: "12345",
      sourceCommentId: "c1",
      parentSourceCommentId: null,
      authorName: "Commenter",
      authorProfileUrl: null,
      postedAt: "Sat 15 Nov 2025 12:16AM UTC",
      depth: 0,
      fromWorkCreator: false,
      textHtml: "<p>Nice work.</p>",
      contentHash: `sha256:${"d".repeat(64)}`,
    }];
    records.kudos = [{
      sourceWorkId: "12345",
      sourceKudoId: "user:Commenter",
      authorName: "Commenter",
      authorProfileUrl: null,
      observedAt: "2026-08-17T12:00:00.000Z",
    }];
    records.bookmarks = [{
      operation: "upsert",
      sourceBookmarkId: "bookmark:12345:Commenter",
      sourceWorkId: "12345",
      bookmarkerName: "Commenter",
      bookmarkerProfileUrl: null,
      notesHtml: "",
      tags: [{ name: "to read" }],
      updatedAt: "20 Aug 2026",
      contentHash: `sha256:${"e".repeat(64)}`,
    }];
    const workId = await store.persistCapturedWork(sourceId, records);

    expect(firstCount(await db.select({ value: count() }).from(works).where(eq(works.id, workId)))).toBe(1);
    expect(firstCount(await db.select({ value: count() }).from(chapters).where(eq(chapters.workId, workId)))).toBe(2);
    expect(firstCount(await db.select({ value: count() }).from(workTags).where(eq(workTags.workId, workId)))).toBe(7);
    expect(firstCount(await db.select({ value: count() }).from(seriesWorks).where(eq(seriesWorks.workId, workId)))).toBe(1);

    const updated = structuredClone(records);
    updated.works[0]!.title = "Updated integration title";
    updated.works[0]!.contentHash = `sha256:${"b".repeat(64)}`;
    updated.chapters = [updated.chapters[1]!];
    updated.chapters[0]!.position = 1;
    updated.workTags = updated.workTags.slice(0, 3);
    const secondId = await store.persistCapturedWork(sourceId, updated);

    expect(secondId).toBe(workId);
    expect((await db.select({ title: works.title }).from(works).where(eq(works.id, workId)))[0]!.title).toBe("Updated integration title");
    expect(firstCount(await db.select({ value: count() }).from(chapters).where(eq(chapters.workId, workId)))).toBe(1);
    expect(firstCount(await db.select({ value: count() }).from(workTags).where(eq(workTags.workId, workId)))).toBe(3);
    expect(firstCount(await db.select({ value: count() }).from(observations).where(eq(observations.sourceWorkId, "12345")))).toBe(1);

    const exportRoot = await mkdtemp(join(tmpdir(), "ao3-mariadb-exports-"));
    try {
      const queue = new ExportQueueStore(db);
      const worker = new ExportWorker("integration-exporter", queue, new MariaDbPackageExporter(db), 30_000);
      const firstRequest = await queue.createRequest(sourceId, exportRoot, 100);
      expect(await worker.processOne()).toBe(true);
      const exported = await readTransferPackage(join(exportRoot, firstRequest.packageId));
      const firstRun = (await db.select().from(exportRuns).where(eq(exportRuns.id, firstRequest.id)))[0]!;
      expect(firstRun.archiveHash).toMatch(/^sha256:[a-f0-9]{64}$/);
      expect(firstRun.archivePath).toBe(`${join(exportRoot, firstRequest.packageId)}.tar.gz`);
      expect((await stat(firstRun.archivePath!)).size).toBe(firstRun.archiveBytes);
      expect(firstRun.verifiedAt).toBeInstanceOf(Date);
      expect(exported.manifest).toMatchObject({ packageId: firstRequest.packageId, packageType: "snapshot", previousPackageId: null });
      expect(exported.records.works).toMatchObject([{ title: "Updated integration title" }]);
      expect(exported.records.chapters).toHaveLength(1);
      expect(exported.records.workTags).toHaveLength(3);
      expect(exported.records.seriesWorks).toHaveLength(1);
      expect(exported.records.comments).toEqual([expect.objectContaining({ sourceCommentId: "c1", textHtml: "<p>Nice work.</p>" })]);
      expect(exported.records.kudos).toEqual([expect.objectContaining({ sourceKudoId: "user:Commenter" })]);
      expect(exported.records.bookmarks).toEqual([expect.objectContaining({ sourceBookmarkId: "bookmark:12345:Commenter", tags: [{ name: "to read" }] })]);

      await db.update(works).set({ title: "Changed after export", contentHash: `sha256:${"c".repeat(64)}` })
        .where(eq(works.id, workId));
      const secondRequest = await queue.createRequest(sourceId, exportRoot, 100);
      const thirdRequest = await queue.createRequest(sourceId, exportRoot, 100);
      const [claimA, claimB] = await Promise.all([
        queue.claim("export-worker-a", 30_000),
        queue.claim("export-worker-b", 30_000),
      ]);
      const activeClaim = claimA ?? claimB;
      expect(activeClaim).not.toBeNull();
      expect([claimA, claimB].filter(Boolean)).toHaveLength(1);
      expect(activeClaim!.sequenceNumber).toBe(2);
      expect(activeClaim!.previousPackageId).toBe(firstRequest.packageId);
      await queue.markWriting(activeClaim!.id, activeClaim!.leaseToken);
      await new MariaDbPackageExporter(db).processClaimed(activeClaim!);

      const waitingClaim = await queue.claim("export-worker-b", 30_000);
      expect(waitingClaim).not.toBeNull();
      expect(waitingClaim!.sequenceNumber).toBe(3);
      expect(waitingClaim!.previousPackageId).toBe(activeClaim!.packageId);
      await queue.markWriting(waitingClaim!.id, waitingClaim!.leaseToken);
      expect(await new MariaDbPackageExporter(db).processClaimed(waitingClaim!)).toBe("empty");

      const incremental = await readTransferPackage(join(exportRoot, activeClaim!.packageId));
      expect(incremental.manifest).toMatchObject({
        packageId: activeClaim!.packageId, packageType: "incremental", previousPackageId: firstRequest.packageId,
      });
      expect(incremental.records.works).toMatchObject([{ title: "Changed after export" }]);
      const runs = await db.select().from(exportRuns).where(inArray(exportRuns.id, [secondRequest.id, thirdRequest.id]));
      expect(new Set(runs.map((run) => run.sequenceNumber)).size).toBe(2);
      expect((await db.select().from(exportRuns).where(eq(exportRuns.status, "completed")))).toHaveLength(2);
    } finally {
      await rm(exportRoot, { recursive: true, force: true });
    }
  });

  it("creates explicit-IDs jobs and finds gaps excluding handled IDs", async () => {
    await db.insert(works).values({
      sourceId, sourceWorkId: "2", sourceUrl: "https://example/2", title: "Two",
      summaryHtml: "", notesHtml: "", endNotesHtml: "", languageCode: "en",
      complete: true, restricted: false, contentHash: `sha256:${'a'.repeat(64)}`,
      firstSeenAt: new Date(), lastSeenAt: new Date(),
    });
    await db.insert(observations).values({
      sourceId, sourceWorkId: "3", observedAt: new Date(), availability: "not_found", httpStatus: 404, sourceUpdatedAt: null, contentHash: null,
    });
    await store.createExplicitIdsJob(sourceId, ["4"]);

    const { ids, nextCursor } = await store.findGaps(sourceId, 1, 10, 5);
    expect(ids).toEqual(["1", "5", "6", "7", "8"]);
    expect(ids).not.toContain("2");
    expect(ids).not.toContain("3");
    expect(ids).not.toContain("4");
    expect(nextCursor).toBeNull(); // whole [1..10] range was scanned

    const cov = await store.coverage(sourceId, 1, 10);
    expect(cov).toMatchObject({ total: 10, collected: 1, notFound: 1, attempted: 1, missing: 7 });
  }, 15_000);

  it("persists and advances the auto-fill configuration", async () => {
    const auto = new AutoFillStore(db);
    expect((await auto.get(sourceId)).enabled).toBe(false);
    await auto.update(sourceId, { enabled: true, batchSize: 50 });
    expect((await auto.get(sourceId))).toMatchObject({ enabled: true, batchSize: 50 });
    const jobId = await store.createExplicitIdsJob(sourceId, ["1", "2"]);
    await auto.recordRun(sourceId, jobId, 3);
    const afterRun = await auto.get(sourceId);
    expect(afterRun.lastJobId).toBe(jobId);
    expect(afterRun.frontierStart).toBe(3);
    expect(afterRun.lastRunAt).not.toBeNull();
  }, 15_000);

  it("requeues expired planning leases and reports stalled running jobs", async () => {
    const captured: Array<{ event: string; message?: string; context?: Record<string, unknown> }> = [];
    const events = { record: async (input: { event: string; message?: string; context?: Record<string, unknown> }) => { captured.push(input); } } as unknown as EventLog;
    const leaseStore = new TaskLeaseStore(db, events);

    const planningJob = await store.createIdRangeJob(sourceId, { start: 1, end: 100, batchSize: 10 });
    await db.update(collectionJobs).set({
      status: "running", planningStatus: "planning", planningLeaseToken: "dead-worker:abc",
      planningLeaseExpiresAt: new Date(Date.now() - 60_000), updatedAt: new Date(Date.now() - 2 * 60_000),
    }).where(eq(collectionJobs.id, planningJob));
    expect(await leaseStore.reclaimExpiredPlanning()).toBe(1);
    const reclaimed = (await db.select().from(collectionJobs).where(eq(collectionJobs.id, planningJob)))[0]!;
    expect(reclaimed.planningStatus).toBe("queued");
    expect(reclaimed.planningLeaseToken).toBeNull();

    const stalledJob = await store.createIdRangeJob(sourceId, { start: 1, end: 3, batchSize: 2 });
    await store.enqueueWorkIds(stalledJob, ["1", "2"]);
    await db.update(collectionJobs).set({
      status: "running", planningStatus: "completed", updatedAt: new Date(Date.now() - 30 * 60_000),
    }).where(eq(collectionJobs.id, stalledJob));
    await leaseStore.detectStalledJobs(new Date(), 10 * 60_000);
    expect(captured.some((entry) => entry.event === "job_stalled" && String(entry.context?.reason) === "worker_stalled")).toBe(true);
  }, 15_000);
});
