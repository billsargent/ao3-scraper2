import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FORMAT_VERSION, type TransferRecords } from "@ao3-offsite/contracts";
import { writeTransferPackage } from "@ao3-offsite/package-tools";
import { parseEntireWorkHtml } from "@ao3-offsite/scraper-core";

const [idFileArgument, datasetArgument] = process.argv.slice(2);
if (!idFileArgument || !datasetArgument) {
  console.error("Usage: reprocess-work-dataset <work-ids.txt> <dataset-directory>");
  process.exit(2);
}
const ids = (await readFile(resolve(idFileArgument), "utf8")).split(/\r?\n/).map((id) => id.trim()).filter(Boolean);
const dataset = resolve(datasetArgument);
const rawDirectory = resolve(dataset, "raw");
const packageDirectory = resolve(dataset, "package");
const records: TransferRecords = {
  authors: [], workAuthors: [], works: [], chapters: [], tags: [], workTags: [], series: [], seriesWorks: [], observations: [],
};
const report: Array<Record<string, unknown>> = [];

function mergeUnique<T>(target: T[], incoming: T[], key: (record: T) => string): void {
  const known = new Set(target.map(key));
  for (const record of incoming) if (!known.has(key(record))) { target.push(record); known.add(key(record)); }
}

for (const sourceWorkId of ids) {
  try {
    const html = await readFile(resolve(rawDirectory, `${sourceWorkId}.html`), "utf8");
    const parsed = parseEntireWorkHtml(html, {
      sourceUrl: `https://archiveofourown.org/works/${sourceWorkId}?view_full_work=true&view_adult=true`,
      capturedAt: new Date().toISOString(),
    });
    mergeUnique(records.authors, parsed.authors, (row) => row.sourceAuthorId);
    mergeUnique(records.workAuthors, parsed.workAuthors, (row) => `${row.sourceWorkId}:${row.sourceAuthorId}`);
    mergeUnique(records.works, parsed.works, (row) => row.sourceWorkId);
    mergeUnique(records.chapters, parsed.chapters, (row) => `${row.sourceWorkId}:${row.sourceChapterId}`);
    mergeUnique(records.tags, parsed.tags, (row) => row.sourceTagId);
    mergeUnique(records.workTags, parsed.workTags, (row) => `${row.sourceWorkId}:${row.sourceTagId}`);
    mergeUnique(records.series, parsed.series, (row) => row.sourceSeriesId);
    mergeUnique(records.seriesWorks, parsed.seriesWorks, (row) => `${row.sourceSeriesId}:${row.sourceWorkId}`);
    mergeUnique(records.observations, parsed.observations, (row) => `${row.sourceWorkId}:${row.observedAt}`);
    report.push({ sourceWorkId, status: "parsed", chapters: parsed.chapters.length, tags: parsed.tags.length });
  } catch (error) {
    report.push({ sourceWorkId, status: "failed", error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
}

await mkdir(dataset, { recursive: true });
await writeFile(resolve(dataset, "reprocess-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
await writeTransferPackage(packageDirectory, {
  manifest: {
    format: "ao3-offsite-transfer", formatVersion: FORMAT_VERSION, packageId: randomUUID(), packageType: "snapshot",
    source: { key: "ao3", origin: "https://archiveofourown.org" }, createdAt: new Date().toISOString(),
    collectorVersion: "live-dataset-reprocess-v1", previousPackageId: null,
    records: {
      authors: records.authors.length, workAuthors: records.workAuthors.length, works: records.works.length,
      chapters: records.chapters.length, tags: records.tags.length, workTags: records.workTags.length,
      series: records.series.length, seriesWorks: records.seriesWorks.length, observations: records.observations.length,
    },
  },
  records,
});
console.log(JSON.stringify({ requested: ids.length, parsed: records.works.length, failed: report.filter((row) => row.status === "failed").length, packageDirectory }, null, 2));
