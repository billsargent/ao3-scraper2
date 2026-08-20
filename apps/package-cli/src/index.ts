import { createHash, randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { FORMAT_VERSION, type TransferPackage } from "@ao3-offsite/contracts";
import { readTransferPackage, writeTransferPackage } from "@ao3-offsite/package-tools";

const hash = (text: string): `sha256:${string}` => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function samplePackage(): TransferPackage {
  const chapterHtml = "<p>This is a local import test chapter.</p>";
  const workHash = hash(`Example Work\n${chapterHtml}`);
  return {
    manifest: {
      format: "ao3-offsite-transfer",
      formatVersion: FORMAT_VERSION,
      packageId: randomUUID(),
      packageType: "snapshot",
      source: { key: "ao3", origin: "https://archiveofourown.org" },
      createdAt: new Date().toISOString(),
      collectorVersion: "0.1.0",
      previousPackageId: null,
      records: {
        authors: 1,
        workAuthors: 1,
        works: 1,
        chapters: 1,
        tags: 3,
        workTags: 3,
        series: 1,
        seriesWorks: 1,
        observations: 1,
      },
    },
    records: {
      authors: [{
        sourceAuthorId: "user:ExampleAuthor",
        name: "ExampleAuthor",
        profileUrl: "https://archiveofourown.org/users/ExampleAuthor",
        anonymous: false,
        orphaned: false,
      }],
      workAuthors: [{ sourceWorkId: "12345", sourceAuthorId: "user:ExampleAuthor", position: 1 }],
      works: [{
        operation: "upsert",
        sourceWorkId: "12345",
        sourceUrl: "https://archiveofourown.org/works/12345",
        title: "Example Work",
        summaryHtml: "<p>An importer fixture.</p>",
        languageCode: "en",
        publishedAt: "2021-04-20",
        updatedAt: "2021-04-20",
        complete: true,
        restricted: false,
        expectedChapters: 1,
        words: 9,
        notesHtml: "",
        endNotesHtml: "",
        contentHash: workHash,
      }],
      chapters: [{
        sourceWorkId: "12345",
        sourceChapterId: "23456",
        position: 1,
        title: "Chapter 1",
        summaryHtml: "",
        notesHtml: "",
        contentHtml: chapterHtml,
        endNotesHtml: "",
        publishedAt: "2021-04-20",
        wordCount: 9,
        contentHash: hash(chapterHtml),
      }],
      tags: [
        { sourceTagId: "rating:general", type: "Rating", name: "General Audiences", canonical: true, sourceUrl: null },
        { sourceTagId: "warning:none", type: "ArchiveWarning", name: "No Archive Warnings Apply", canonical: true, sourceUrl: null },
        { sourceTagId: "fandom:example", type: "Fandom", name: "Example Fandom", canonical: true, sourceUrl: null },
      ],
      workTags: [
        { sourceWorkId: "12345", sourceTagId: "rating:general", position: 0 },
        { sourceWorkId: "12345", sourceTagId: "warning:none", position: 1 },
        { sourceWorkId: "12345", sourceTagId: "fandom:example", position: 2 },
      ],
      series: [{
        sourceSeriesId: "series:100",
        name: "Example Series",
        sourceUrl: "https://archiveofourown.org/series/100",
        summaryHtml: "<p>An importer series fixture.</p>",
        complete: true,
      }],
      seriesWorks: [{ sourceSeriesId: "series:100", sourceWorkId: "12345", position: 1 }],
      observations: [{
        sourceWorkId: "12345",
        observedAt: new Date().toISOString(),
        availability: "public",
        httpStatus: 200,
        sourceUpdatedAt: "2021-04-20",
        contentHash: workHash,
      }],
      comments: [],
      kudos: [],
      bookmarks: [],
    },
  };
}

function updatePackage(previous: TransferPackage): TransferPackage {
  const transfer = samplePackage();
  const firstChapterHtml = "<p>This chapter was updated in the second package.</p>";
  const secondChapterHtml = "<p>This is a newly added second chapter.</p>";
  const work = transfer.records.works[0]!;
  const firstChapter = transfer.records.chapters[0]!;

  transfer.manifest.packageType = "incremental";
  transfer.manifest.previousPackageId = previous.manifest.packageId;
  transfer.manifest.records.chapters = 2;
  transfer.manifest.records.tags = 4;
  transfer.manifest.records.workTags = 4;
  work.title = "Example Work Updated";
  work.updatedAt = "2026-08-17";
  work.expectedChapters = 2;
  work.words = 18;
  work.contentHash = hash(`${work.title}\n${firstChapterHtml}\n${secondChapterHtml}`);
  firstChapter.contentHtml = firstChapterHtml;
  firstChapter.wordCount = 9;
  firstChapter.contentHash = hash(firstChapterHtml);
  transfer.records.chapters.push({
    sourceWorkId: "12345",
    sourceChapterId: "34567",
    position: 2,
    title: "Chapter 2",
    summaryHtml: "",
    notesHtml: "",
    contentHtml: secondChapterHtml,
    endNotesHtml: "",
    publishedAt: "2026-08-17",
    wordCount: 9,
    contentHash: hash(secondChapterHtml),
  });
  transfer.records.tags.push({
    sourceTagId: "freeform:update-test",
    type: "Freeform",
    name: "Incremental Update Test",
    canonical: false,
    sourceUrl: null,
  });
  transfer.records.workTags.push({ sourceWorkId: "12345", sourceTagId: "freeform:update-test", position: 3 });
  transfer.records.series[0]!.name = "Example Series Updated";
  transfer.records.observations[0]!.sourceUpdatedAt = "2026-08-17";
  transfer.records.observations[0]!.contentHash = work.contentHash;
  return transfer;
}

async function main(): Promise<void> {
  const [command, firstPath, secondPath] = process.argv.slice(2);
  if (!command || !firstPath || !["sample", "sample-update", "verify"].includes(command)) {
    console.error("Usage: package-cli sample <directory> | sample-update <base-directory> <output-directory> | verify <directory>");
    process.exitCode = 2;
    return;
  }
  if (command === "sample") {
    const directory = resolve(firstPath);
    await writeTransferPackage(directory, samplePackage());
    console.log(`Wrote valid sample transfer package to ${directory}`);
    return;
  }
  if (command === "sample-update") {
    if (!secondPath) throw new Error("sample-update requires base and output directories");
    const previous = await readTransferPackage(resolve(firstPath));
    const output = resolve(secondPath);
    await writeTransferPackage(output, updatePackage(previous));
    console.log(`Wrote valid incremental sample package to ${output}`);
    return;
  }
  const transfer = await readTransferPackage(resolve(firstPath));
  console.log(JSON.stringify({ valid: true, packageId: transfer.manifest.packageId, records: transfer.manifest.records }, null, 2));
}

await main();
