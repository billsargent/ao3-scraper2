import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { readTransferPackage } from "@ao3-offsite/package-tools";
import { parseEntireWorkHtml } from "@ao3-offsite/scraper-core";
import { MariaDbPackageExporter } from "../src/exporter.js";
import { CollectorStore } from "../src/store.js";
import { TaskLeaseStore } from "../src/task-store.js";

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
    leases = new TaskLeaseStore(db);
  });

  beforeEach(async () => {
    await db.delete(collectionTasks);
    await db.delete(collectionJobs);
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

    const outputDirectory = await mkdtemp(join(tmpdir(), "ao3-mariadb-export-"));
    try {
      const packageId = await new MariaDbPackageExporter(db).export({
        sourceId,
        sourceKey: "integration-test",
        origin: "https://archiveofourown.org",
        sourceWorkIds: ["12345"],
        outputDirectory,
      });
      const exported = await readTransferPackage(outputDirectory);
      expect(exported.manifest.packageId).toBe(packageId);
      expect(exported.records.works).toMatchObject([{ title: "Updated integration title" }]);
      expect(exported.records.chapters).toHaveLength(1);
      expect(exported.records.workTags).toHaveLength(3);
      expect(exported.records.seriesWorks).toHaveLength(1);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
