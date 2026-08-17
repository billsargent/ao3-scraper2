import { eq } from "drizzle-orm";
import { CollectorStore } from "@ao3-offsite/collector";
import { createDatabase, sources } from "@ao3-offsite/database";
import { readTransferPackage } from "@ao3-offsite/package-tools";
import type { TransferRecords } from "@ao3-offsite/contracts";

const [packageDirectory] = process.argv.slice(2);
if (!packageDirectory) {
  console.error("Usage: load-package-into-collector <package-directory>");
  process.exit(2);
}
const { db, pool } = createDatabase();
try {
  const transfer = await readTransferPackage(packageDirectory);
  const sourceKey = transfer.manifest.source.key;
  let source = (await db.select().from(sources).where(eq(sources.key, sourceKey)).limit(1))[0];
  if (!source) {
    const sourceId = (await db.insert(sources).values({
      key: sourceKey,
      origin: transfer.manifest.source.origin,
      minimumDelayMs: 10_000,
      dailyRequestBudget: 250,
      paused: true,
    }).$returningId())[0]!.id;
    source = (await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1))[0]!;
  }
  const store = new CollectorStore(db);
  for (const work of transfer.records.works) {
    const workAuthors = transfer.records.workAuthors.filter((row) => row.sourceWorkId === work.sourceWorkId);
    const authorIds = new Set(workAuthors.map((row) => row.sourceAuthorId));
    const workTags = transfer.records.workTags.filter((row) => row.sourceWorkId === work.sourceWorkId);
    const tagIds = new Set(workTags.map((row) => row.sourceTagId));
    const seriesWorks = transfer.records.seriesWorks.filter((row) => row.sourceWorkId === work.sourceWorkId);
    const seriesIds = new Set(seriesWorks.map((row) => row.sourceSeriesId));
    const records: TransferRecords = {
      works: [work],
      chapters: transfer.records.chapters.filter((row) => row.sourceWorkId === work.sourceWorkId),
      authors: transfer.records.authors.filter((row) => authorIds.has(row.sourceAuthorId)),
      workAuthors,
      tags: transfer.records.tags.filter((row) => tagIds.has(row.sourceTagId)),
      workTags,
      series: transfer.records.series.filter((row) => seriesIds.has(row.sourceSeriesId)),
      seriesWorks,
      observations: transfer.records.observations.filter((row) => row.sourceWorkId === work.sourceWorkId),
    };
    await store.persistCapturedWork(source.id, records);
  }
  console.log(JSON.stringify({ sourceId: source.id, loadedWorks: transfer.records.works.length, sourcePaused: source.paused }, null, 2));
} finally {
  await pool.end();
}
