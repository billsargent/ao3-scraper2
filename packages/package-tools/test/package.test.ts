import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FORMAT_VERSION, type TransferPackage } from "@ao3-offsite/contracts";
import { PackageValidationError, readTransferPackage, writeTransferPackage } from "../src/index.js";

const directories: string[] = [];
const digest = (text: string): `sha256:${string}` => `sha256:${createHash("sha256").update(text).digest("hex")}`;

function fixture(): TransferPackage {
  const content = "<p>Test chapter</p>";
  return {
    manifest: {
      format: "ao3-offsite-transfer",
      formatVersion: FORMAT_VERSION,
      packageId: randomUUID(),
      packageType: "snapshot",
      source: { key: "ao3", origin: "https://archiveofourown.org" },
      createdAt: "2026-08-17T12:00:00.000Z",
      collectorVersion: "test",
      previousPackageId: null,
      records: { authors: 1, workAuthors: 1, works: 1, chapters: 1, tags: 1, workTags: 1, series: 0, seriesWorks: 0, observations: 1 },
    },
    records: {
      authors: [{ sourceAuthorId: "author-1", name: "Author", profileUrl: null, anonymous: false, orphaned: false }],
      workAuthors: [{ sourceWorkId: "work-1", sourceAuthorId: "author-1", position: 1 }],
      works: [{
        operation: "upsert", sourceWorkId: "work-1", sourceUrl: "https://archiveofourown.org/works/1",
        title: "Work", summaryHtml: "", languageCode: "en", publishedAt: null, updatedAt: null,
        complete: true, restricted: false, expectedChapters: 1, words: 2, notesHtml: "", endNotesHtml: "", contentHash: digest(content),
      }],
      chapters: [{
        sourceWorkId: "work-1", sourceChapterId: "chapter-1", position: 1, title: "", summaryHtml: "", notesHtml: "",
        contentHtml: content, endNotesHtml: "", publishedAt: null, wordCount: 2, contentHash: digest(content),
      }],
      tags: [{ sourceTagId: "tag-1", type: "Fandom", name: "Test Fandom", canonical: null, sourceUrl: null }],
      workTags: [{ sourceWorkId: "work-1", sourceTagId: "tag-1", position: 0 }],
      series: [], seriesWorks: [],
      observations: [{
        sourceWorkId: "work-1", observedAt: "2026-08-17T12:00:00.000Z", availability: "public",
        httpStatus: 200, sourceUpdatedAt: null, contentHash: digest(content),
      }],
    },
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "ao3-transfer-"));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("transfer package", () => {
  it("round-trips a valid package", async () => {
    const directory = await temporaryDirectory();
    const original = fixture();
    await writeTransferPackage(directory, original);
    const loaded = await readTransferPackage(directory);
    expect(loaded).toEqual(original);
  });

  it("detects a modified data file", async () => {
    const directory = await temporaryDirectory();
    await writeTransferPackage(directory, fixture());
    await writeFile(join(directory, "chapters.jsonl"), "{}\n", "utf8");
    await expect(readTransferPackage(directory)).rejects.toThrow("Checksum mismatch for chapters.jsonl");
  });

  it("rejects dangling references before writing", async () => {
    const directory = await temporaryDirectory();
    const transfer = fixture();
    transfer.records.chapters[0]!.sourceWorkId = "missing";
    await expect(writeTransferPackage(directory, transfer)).rejects.toThrow("Chapter references missing work missing");
  });

  it("rejects a count mismatch", async () => {
    const directory = await temporaryDirectory();
    const transfer = fixture();
    transfer.manifest.records.works = 2;
    await expect(writeTransferPackage(directory, transfer)).rejects.toBeInstanceOf(PackageValidationError);
  });

  it("writes deterministic JSONL formatting", async () => {
    const directory = await temporaryDirectory();
    await writeTransferPackage(directory, fixture());
    const content = await readFile(join(directory, "works.jsonl"), "utf8");
    expect(content.split("\n")).toHaveLength(2);
    expect(content.endsWith("\n")).toBe(true);
  });
});
