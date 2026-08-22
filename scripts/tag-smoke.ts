/* Smoke test for the Tag archive feature against the dev DB.
 * Runs the real code path: PoliteSourceClient fetch -> parseTagWorksHtml ->
 * filterUncollected -> createExplicitIdsJob -> recordRun, using a local
 * fake-AO3 HTTP server so no real requests are made.
 * Usage: COLLECTOR_DATABASE_URL='mysql://...' npx tsx scripts/tag-smoke.ts
 */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { and, eq } from "drizzle-orm";
import {
  collectionJobs, collectionTasks, createDatabase, observations, sources, tagSubscriptions, works,
} from "@ao3-offsite/database";
import { MariaDbApiServices } from "../apps/api/src/services.js";

const databaseUrl = process.env.COLLECTOR_DATABASE_URL ?? "mysql://collector:collector_local_only@localhost:3307/ao3_collector";

const listingHtml = (items: Array<[string, string]>): string => `<ol class="work index group">
${items.map(([id, title]) => `  <li class="work blurb group" role="article" id="work_${id}">
    <h4 class="heading"><a href="/works/${id}">${title}</a></h4>
  </li>`).join("\n")}
</ol>`;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (decodeURIComponent(url.pathname) === "/tags/M/M/works") {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(listingHtml([
      ["900000001", "Tag Work One"],
      ["900000002", "Tag Work Two"],
      ["900000003", "Tag Work Three"],
    ]));
    return;
  }
  res.statusCode = 404;
  res.end("not found");
});

async function main(): Promise<void> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;
  const { db, pool } = createDatabase(databaseUrl);

  // Clean up any prior smoke source.
  const prior = (await db.select({ id: sources.id }).from(sources).where(eq(sources.key, "tag-smoke")).limit(1))[0];
  if (prior) {
    const jobRows = await db.select({ id: collectionJobs.id }).from(collectionJobs).where(eq(collectionJobs.sourceId, prior.id));
    for (const job of jobRows) await db.delete(collectionTasks).where(eq(collectionTasks.jobId, job.id));
    await db.delete(collectionJobs).where(eq(collectionJobs.sourceId, prior.id));
    await db.delete(works).where(eq(works.sourceId, prior.id));
    await db.delete(observations).where(eq(observations.sourceId, prior.id));
    await db.delete(tagSubscriptions).where(eq(tagSubscriptions.sourceId, prior.id));
    await db.delete(sources).where(eq(sources.id, prior.id));
  }

  const sourceId = (await db.insert(sources).values({
    key: "tag-smoke",
    origin,
    userAgent: "Archive Relay smoke test / tag-archive",
    includeAdult: true,
    minimumDelayMs: 0,
  }).$returningId())[0]!.id;

  // Pre-seed one collected work so it must be filtered out.
  await db.insert(works).values({
    sourceId,
    sourceWorkId: "900000002",
    sourceUrl: `${origin}/works/900000002`,
    title: "Tag Work Two",
    summaryHtml: "", notesHtml: "", endNotesHtml: "", languageCode: "en",
    complete: true, restricted: false, contentHash: `sha256:${"a".repeat(64)}`,
    firstSeenAt: new Date(), lastSeenAt: new Date(),
  });

  const services = new MariaDbApiServices(db);
  const subscription = await services.createTagSubscription(sourceId, { tagName: "M/M", tagSlug: "M%2FM", tagType: "Category" });
  const result = await services.queueTagPage(subscription.id);

  const reloaded = (await db.select().from(tagSubscriptions).where(eq(tagSubscriptions.id, subscription.id)).limit(1))[0]!;
  const job = result.jobId === null ? null : (await db.select().from(collectionJobs).where(eq(collectionJobs.id, result.jobId)).limit(1))[0];
  const pending = await services["collector"].countPendingTasks(sourceId);

  const ok = (name: string, condition: boolean, detail?: unknown): void => {
    console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail === undefined ? "" : `  ${JSON.stringify(detail)}`}`);
    if (!condition) process.exitCode = 1;
  };

  ok("job created", result.jobId !== null, { jobId: result.jobId });
  ok("enqueued only uncollected works", result.enqueued === 2, { enqueued: result.enqueued, page: result.page });
  ok("cursor advanced", reloaded.nextPage === 2, { nextPage: reloaded.nextPage });
  ok("last job recorded", reloaded.lastJobId === result.jobId, { lastJobId: reloaded.lastJobId });
  ok("job is explicit_ids", job?.type === "explicit_ids", { type: job?.type, status: job?.status });
  ok("two tasks pending", pending === 2, { pending });

  // Clean up after ourselves.
  const jobRows = await db.select({ id: collectionJobs.id }).from(collectionJobs).where(eq(collectionJobs.sourceId, sourceId));
  for (const jobRow of jobRows) await db.delete(collectionTasks).where(and(eq(collectionTasks.jobId, jobRow.id)));
  await db.delete(collectionJobs).where(eq(collectionJobs.sourceId, sourceId));
  await db.delete(works).where(eq(works.sourceId, sourceId));
  await db.delete(observations).where(eq(observations.sourceId, sourceId));
  await db.delete(tagSubscriptions).where(eq(tagSubscriptions.sourceId, sourceId));
  await db.delete(sources).where(eq(sources.id, sourceId));

  await pool.end();
  server.close();
}

main().catch((error) => { console.error(error); process.exit(1); });
