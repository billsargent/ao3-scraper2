import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { FORMAT_VERSION, type TransferRecords } from "@ao3-offsite/contracts";
import { writeTransferPackage } from "@ao3-offsite/package-tools";
import { PoliteSourceClient, parseEntireWorkHtml } from "@ao3-offsite/scraper-core";

const [idFileArgument, outputArgument] = process.argv.slice(2);
if (!idFileArgument || !outputArgument) {
  console.error("Usage: capture-work-dataset <work-ids.txt> <output-directory>");
  process.exit(2);
}

const idFile = resolve(idFileArgument);
const output = resolve(outputArgument);
const rawDirectory = resolve(output, "raw");
const packageDirectory = resolve(output, "package");
const ids = (await readFile(idFile, "utf8"))
  .split(/\r?\n/)
  .map((id) => id.trim())
  .filter(Boolean);
const maximumRequests = Number.parseInt(process.env.SOURCE_RUN_REQUEST_BUDGET ?? "25", 10);
if (ids.length > maximumRequests) throw new Error(`Dataset has ${ids.length} IDs but run budget is ${maximumRequests}`);

const origin = process.env.SOURCE_ORIGIN ?? "https://archiveofourown.org";
const includeAdult = (process.env.SOURCE_INCLUDE_ADULT ?? "true") === "true";
const client = new PoliteSourceClient({
  origin,
  userAgent: process.env.SOURCE_USER_AGENT ?? "AO3-Offsite-Collector/0.1 (private offline parser dataset)",
  minimumDelayMs: Number.parseInt(process.env.SOURCE_MINIMUM_DELAY_MS ?? "10000", 10),
  maximumAttempts: 2,
});
await mkdir(rawDirectory, { recursive: true });

const records: TransferRecords = {
  authors: [], workAuthors: [], works: [], chapters: [], tags: [], workTags: [],
  series: [], seriesWorks: [], observations: [],
};
const report: Array<Record<string, unknown>> = [];

function mergeUnique<T>(target: T[], incoming: T[], key: (record: T) => string): void {
  const known = new Set(target.map(key));
  for (const record of incoming) {
    const identity = key(record);
    if (!known.has(identity)) {
      target.push(record);
      known.add(identity);
    }
  }
}

for (const [index, sourceWorkId] of ids.entries()) {
  const url = new URL(`/works/${sourceWorkId}`, origin);
  url.searchParams.set("view_full_work", "true");
  if (includeAdult) url.searchParams.set("view_adult", "true");
  console.log(`[${index + 1}/${ids.length}] ${url}`);
  try {
    const fetched = await client.fetchText(url);
    await writeFile(resolve(rawDirectory, `${sourceWorkId}.html`), fetched.body, "utf8");
    const parsed = parseEntireWorkHtml(fetched.body, { sourceUrl: fetched.url, capturedAt: fetched.fetchedAt });
    mergeUnique(records.authors, parsed.authors, (row) => row.sourceAuthorId);
    mergeUnique(records.workAuthors, parsed.workAuthors, (row) => `${row.sourceWorkId}:${row.sourceAuthorId}`);
    mergeUnique(records.works, parsed.works, (row) => row.sourceWorkId);
    mergeUnique(records.chapters, parsed.chapters, (row) => `${row.sourceWorkId}:${row.sourceChapterId}`);
    mergeUnique(records.tags, parsed.tags, (row) => row.sourceTagId);
    mergeUnique(records.workTags, parsed.workTags, (row) => `${row.sourceWorkId}:${row.sourceTagId}`);
    mergeUnique(records.series, parsed.series, (row) => row.sourceSeriesId);
    mergeUnique(records.seriesWorks, parsed.seriesWorks, (row) => `${row.sourceSeriesId}:${row.sourceWorkId}`);
    mergeUnique(records.observations, parsed.observations, (row) => `${row.sourceWorkId}:${row.observedAt}`);
    report.push({ sourceWorkId, status: "parsed", bytes: Buffer.byteLength(fetched.body), chapters: parsed.chapters.length, tags: parsed.tags.length });
  } catch (error) {
    report.push({ sourceWorkId, status: "failed", error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) });
  }
}

await writeFile(resolve(output, "capture-report.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
if (records.works.length > 0) {
  await writeTransferPackage(packageDirectory, {
    manifest: {
      format: "ao3-offsite-transfer",
      formatVersion: FORMAT_VERSION,
      packageId: randomUUID(),
      packageType: "snapshot",
      source: { key: "ao3", origin },
      createdAt: new Date().toISOString(),
      collectorVersion: "live-dataset-v1",
      previousPackageId: null,
      records: {
        authors: records.authors.length,
        workAuthors: records.workAuthors.length,
        works: records.works.length,
        chapters: records.chapters.length,
        tags: records.tags.length,
        workTags: records.workTags.length,
        series: records.series.length,
        seriesWorks: records.seriesWorks.length,
        observations: records.observations.length,
      },
    },
    records,
  });
}
console.log(JSON.stringify({ requested: ids.length, parsed: records.works.length, failed: report.filter((row) => row.status === "failed").length, output }, null, 2));
