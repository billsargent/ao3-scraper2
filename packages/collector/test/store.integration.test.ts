import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  authors,
  chapters,
  collectionJobs,
  collectionTasks,
  createDatabase,
  fetchSnapshots,
  observations,
  series,
  seriesWorks,
  sources,
  tags,
  workAuthors,
  works,
  workTags,
  type CollectorDatabase,
} from "@ao3-offsite/database";
import { parseEntireWorkHtml } from "@ao3-offsite/scraper-core";
import { CollectorStore } from "../src/store.js";

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
  let sourceId: number;

  beforeAll(async () => {
    ({ db, pool } = createDatabase(databaseUrl));
    for (const table of [fetchSnapshots, observations, seriesWorks, series, workTags, tags, chapters, workAuthors, authors, works, collectionTasks, collectionJobs, sources]) {
      await db.delete(table);
    }
    sourceId = (await db.insert(sources).values({
      key: "integration-test",
      origin: "https://archiveofourown.org",
      minimumDelayMs: 5000,
    }).$returningId())[0]!.id;
    store = new CollectorStore(db);
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

  it("upserts and reconciles a normalized work transactionally", async () => {
    const html = await readFile(fileURLToPath(fixtureUrl), "utf8");
    const records = parseEntireWorkHtml(html, {
      sourceUrl: "https://archiveofourown.org/works/12345?view_full_work=true",
      capturedAt: "2026-08-17T12:00:00.000Z",
    });
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
  });
});
