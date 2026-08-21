import { hostname } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";
import {
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
import { createDatabase } from "@ao3-offsite/database";
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
const worker = new CollectorWorker(
  new TaskLeaseStore(db, events),
  budgets,
  processors,
  {
    workerId: configuration.WORKER_ID ?? `${hostname()}:${process.pid}`,
    maximumFailureAttempts: configuration.WORKER_MAXIMUM_FAILURE_ATTEMPTS,
    events,
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
