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
  TagSubscriptionStore,
  TaskLeaseStore,
  WorkTaskProcessor,
  type ClaimedTask,
  type WorkProcessorFactory,
} from "@ao3-offsite/collector";
import { collectionJobs, createDatabase, sources } from "@ao3-offsite/database";
import { parseTagWorksHtml, PoliteSourceClient, tagWorksUrl } from "@ao3-offsite/scraper-core";

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
const tagSubscriptionsStore = new TagSubscriptionStore(db);
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
        if (config.enabled) {
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
        }
      } catch (error) {
        await events.record({
          level: "error",
          event: "auto_fill_failed",
          message: `Auto-fill failed: ${error instanceof Error ? error.message : String(error)}`,
          context: { error: error instanceof Error ? error.stack ?? error.message : String(error) },
        });
      }
      // Tag-based discovery runs independently of the numeric auto-fill.
      const sourceRow = (await db.select({ id: sources.id, paused: sources.paused }).from(sources).orderBy(sources.id).limit(1))[0];
      if (sourceRow && !sourceRow.paused) await runTagAutoFill(sourceRow.id);
    },
  },
);

/**
 * Crawls each enabled tag subscription one listing page per cycle, enqueuing
 * discovered work IDs as explicit-IDs jobs. Runs inside the worker's 10-minute
 * auto-fill cadence; failures are logged (not fatal) so numeric auto-fill and
 * the collector loop are unaffected.
 */
async function runTagAutoFill(sourceId: number): Promise<void> {
  try {
    const subscriptions = await tagSubscriptionsStore.listEnabled(sourceId);
    if (subscriptions.length === 0) return;
    const source = (await db.select({
      origin: sources.origin,
      userAgent: sources.userAgent,
      minimumDelayMs: sources.minimumDelayMs,
      requestTimeoutMs: sources.requestTimeoutMs,
      maximumResponseBytes: sources.maximumResponseBytes,
    }).from(sources).where(eq(sources.id, sourceId)).limit(1))[0];
    if (!source) return;
    for (const subscription of subscriptions) {
      // Don't stack jobs while the last job from this subscription is active.
      if (subscription.lastJobId) {
        const last = (await db.select({ status: collectionJobs.status }).from(collectionJobs).where(eq(collectionJobs.id, subscription.lastJobId)).limit(1))[0];
        if (last && ["queued", "running"].includes(last.status)) continue;
      }
      // Keep the whole-source queued backlog bounded.
      const pending = await store.countPendingTasks(sourceId);
      if (pending > 400) return;
      const client = new PoliteSourceClient({
        origin: source.origin,
        userAgent: source.userAgent,
        minimumDelayMs: source.minimumDelayMs,
        timeoutMs: source.requestTimeoutMs,
        maximumBodyBytes: source.maximumResponseBytes,
        maximumAttempts: 2,
      });
      const url = tagWorksUrl(source.origin, subscription.tagSlug, subscription.nextPage);
      const result = await client.fetchText(url);
      const refs = parseTagWorksHtml(result.body);
      if (refs.length === 0) {
        // Past the end of the listing (or the tag has no more pages) — leave the
        // cursor where it is and re-check on a later cycle.
        await events.record({
          level: "info",
          event: "tag_auto_fill_exhausted",
          message: `Tag "${subscription.tagName}" page ${subscription.nextPage} has no works.`,
          context: { sourceId, subscriptionId: subscription.id, tagSlug: subscription.tagSlug, page: subscription.nextPage },
        });
        continue;
      }
      const discovered = refs.map((ref) => ref.sourceWorkId);
      const fresh = await store.filterUncollected(sourceId, discovered);
      if (fresh.length === 0) {
        await tagSubscriptionsStore.recordRun(subscription.id, subscription.nextPage + 1, null);
        await events.record({
          level: "info",
          event: "tag_auto_fill_skipped",
          message: `Tag "${subscription.tagName}" page ${subscription.nextPage}: nothing new to queue.`,
          context: { sourceId, subscriptionId: subscription.id, tagSlug: subscription.tagSlug, page: subscription.nextPage, discovered: discovered.length },
        });
        continue;
      }
      const jobId = await store.createExplicitIdsJob(sourceId, fresh);
      await tagSubscriptionsStore.recordRun(subscription.id, subscription.nextPage + 1, jobId);
      await events.record({
        level: "info",
        event: "tag_auto_fill_created",
        message: `Tag "${subscription.tagName}" page ${subscription.nextPage}: queued ${fresh.length} works into job #${jobId}.`,
        context: { sourceId, subscriptionId: subscription.id, tagSlug: subscription.tagSlug, page: subscription.nextPage, discovered: discovered.length, enqueued: fresh.length, jobId },
      });
    }
  } catch (error) {
    await events.record({
      level: "error",
      event: "tag_auto_fill_failed",
      message: `Tag auto-fill failed: ${error instanceof Error ? error.message : String(error)}`,
      context: { error: error instanceof Error ? error.stack ?? error.message : String(error), sourceId },
    });
  }
}
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
