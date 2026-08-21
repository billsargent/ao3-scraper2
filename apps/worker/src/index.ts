import { hostname } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { z } from "zod";
import {
  AutoFillStore,
  CollectorStore,
  CollectorWorker,
  ContentAddressedBlobStore,
  EventLog,
  SourceBudgetStore,
  TaskLeaseStore,
  WorkTaskProcessor,
  type ClaimedTask,
  type WorkProcessorFactory,
} from "@ao3-offsite/collector";
import { collectionJobs, createDatabase, sources } from "@ao3-offsite/database";
import { PoliteSourceClient } from "@ao3-offsite/scraper-core";

const configuration = z.object({
  COLLECTOR_DATABASE_URL: z.string().url(),
  COLLECTOR_BLOB_DIRECTORY: z.string().default("./data/blobs"),
  WORKER_ID: z.string().optional(),
  WORKER_MAXIMUM_FAILURE_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
}).parse(process.env);

const { db, pool } = createDatabase(configuration.COLLECTOR_DATABASE_URL);
const store = new CollectorStore(db);
const blobs = new ContentAddressedBlobStore(resolve(configuration.COLLECTOR_BLOB_DIRECTORY));
const budgets = new SourceBudgetStore(db);
const autoFillStore = new AutoFillStore(db);
const events = new EventLog(db, { service: "collector", workerId: configuration.WORKER_ID ?? `${hostname()}:${process.pid}` });
const processors: WorkProcessorFactory = {
  create(task: ClaimedTask) {
    const fetcher = new PoliteSourceClient({
      origin: task.source.origin,
      userAgent: task.source.userAgent,
      minimumDelayMs: task.source.minimumDelayMs,
      timeoutMs: task.source.requestTimeoutMs,
      maximumBodyBytes: task.source.maximumResponseBytes,
      maximumAttempts: 1,
    });
    return new WorkTaskProcessor(
      {
        id: task.source.id,
        origin: task.source.origin,
        includeAdult: task.source.includeAdult,
        captureComments: task.source.captureComments,
        captureKudos: task.source.captureKudos,
        captureBookmarks: task.source.captureBookmarks,
        maximumCommentPages: task.source.maximumCommentPages,
        maximumKudosPages: task.source.maximumKudosPages,
        maximumBookmarkPages: task.source.maximumBookmarkPages,
      },
      fetcher,
      blobs,
      store,
      {
        reserve: async () => {
          const reservation = await budgets.reserveRequest(task.source.id);
          return reservation.granted
            ? { granted: true as const, retryAt: null }
            : { granted: false as const, retryAt: reservation.retryAt };
        },
      },
    );
  },
};
const leases = new TaskLeaseStore(db, events);
const worker = new CollectorWorker(
  leases,
  budgets,
  processors,
  {
    workerId: configuration.WORKER_ID ?? `${hostname()}:${process.pid}`,
    maximumFailureAttempts: configuration.WORKER_MAXIMUM_FAILURE_ATTEMPTS,
    events,
    watchdog: async () => {
      // Requeue planning leases that expired while the planner was down, and
      // report jobs that are running but have stopped making progress.
      await leases.reclaimExpiredPlanning();
      await leases.detectStalledJobs();
    },
    autoFill: async () => {
      try {
        const sourceRow = (await db.select({ id: sources.id, paused: sources.paused }).from(sources).orderBy(sources.id).limit(1))[0];
        if (!sourceRow || sourceRow.paused) return;
        const config = await autoFillStore.get(sourceRow.id);
        if (!config.enabled) return;
        // Don't pile up while the last auto-created job is still active.
        if (config.lastJobId) {
          const last = (await db.select({ status: collectionJobs.status }).from(collectionJobs).where(eq(collectionJobs.id, config.lastJobId)).limit(1))[0];
          if (last && ["queued", "running"].includes(last.status)) return;
        }
        // Keep the queued backlog bounded to ~2x the batch size.
        const pending = await store.countPendingTasks(sourceRow.id);
        if (pending > config.batchSize * 2) return;
        const { ids, nextCursor } = await store.findGaps(
          sourceRow.id,
          config.frontierStart,
          config.frontierStart + config.batchSize * 100,
          config.batchSize,
        );
        if (ids.length === 0) {
          await autoFillStore.update(sourceRow.id, { frontierStart: nextCursor ?? config.frontierStart + config.batchSize * 100 });
          return;
        }
        const jobId = await store.createExplicitIdsJob(sourceRow.id, ids);
        await autoFillStore.recordRun(sourceRow.id, jobId, nextCursor);
        await events.record({
          level: "info",
          event: "auto_fill_created",
          message: `Auto-queued ${ids.length} missing works into job #${jobId}.`,
          context: { jobId, enqueued: ids.length, nextCursor, sourceId: sourceRow.id },
        });
      } catch (error) {
        await events.record({
          level: "error",
          event: "auto_fill_failed",
          message: `Auto-fill failed: ${error instanceof Error ? error.message : String(error)}`,
          context: { error: error instanceof Error ? error.stack ?? error.message : String(error) },
        });
      }
    },
  },
);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => controller.abort());
}

try {
  console.log(JSON.stringify({ event: "worker_started", workerId: configuration.WORKER_ID ?? `${hostname()}:${process.pid}` }));
  await events.record({ level: "info", event: "worker_started", message: "Collector worker started." });
  await worker.run(controller.signal);
} finally {
  await events.record({ level: "info", event: "worker_stopped", message: "Collector worker stopped." });
  await pool.end();
  console.log(JSON.stringify({ event: "worker_stopped" }));
}
