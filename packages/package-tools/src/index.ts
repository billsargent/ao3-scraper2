import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ManifestSchema,
  RecordSchemas,
  type Manifest,
  type TransferPackage,
  type TransferRecords,
} from "@ao3-offsite/contracts";
import type { ZodType } from "zod";

const fileToRecordKey = {
  "authors.jsonl": "authors",
  "work-authors.jsonl": "workAuthors",
  "works.jsonl": "works",
  "chapters.jsonl": "chapters",
  "tags.jsonl": "tags",
  "work-tags.jsonl": "workTags",
  "series.jsonl": "series",
  "series-works.jsonl": "seriesWorks",
  "observations.jsonl": "observations",
} as const satisfies Record<keyof typeof RecordSchemas, keyof TransferRecords>;

const orderedDataFiles = Object.keys(fileToRecordKey) as Array<keyof typeof fileToRecordKey>;
const checksumFiles = ["manifest.json", ...orderedDataFiles] as const;

export class PackageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackageValidationError";
  }
}

function sha256(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function jsonLine(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

function parseJsonLines<T>(content: string, schema: ZodType<T>, fileName: string): T[] {
  if (content.length === 0) return [];
  const lines = content.split("\n");
  if (lines.at(-1) === "") lines.pop();

  return lines.map((line, index) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (error) {
      throw new PackageValidationError(`${fileName}:${index + 1}: invalid JSON: ${String(error)}`);
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new PackageValidationError(
        `${fileName}:${index + 1}: schema validation failed: ${result.error.issues
          .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
          .join("; ")}`,
      );
    }
    return result.data;
  });
}

export function validateReferences(records: TransferRecords): void {
  const workIds = new Set(records.works.map((work) => work.sourceWorkId));
  const authorIds = new Set(records.authors.map((author) => author.sourceAuthorId));
  const tagIds = new Set(records.tags.map((tag) => tag.sourceTagId));
  const seriesIds = new Set(records.series.map((series) => series.sourceSeriesId));

  const unique = (values: string[], label: string): void => {
    if (new Set(values).size !== values.length) {
      throw new PackageValidationError(`Duplicate ${label} identity in package`);
    }
  };

  unique(records.works.map((work) => work.sourceWorkId), "work");
  unique(records.authors.map((author) => author.sourceAuthorId), "author");
  unique(records.tags.map((tag) => tag.sourceTagId), "tag");
  unique(records.series.map((series) => series.sourceSeriesId), "series");
  unique(records.chapters.map((chapter) => `${chapter.sourceWorkId}:${chapter.sourceChapterId}`), "chapter");

  for (const chapter of records.chapters) {
    if (!workIds.has(chapter.sourceWorkId)) throw new PackageValidationError(`Chapter references missing work ${chapter.sourceWorkId}`);
  }
  for (const relation of records.workAuthors) {
    if (!workIds.has(relation.sourceWorkId)) throw new PackageValidationError(`Work-author references missing work ${relation.sourceWorkId}`);
    if (!authorIds.has(relation.sourceAuthorId)) throw new PackageValidationError(`Work-author references missing author ${relation.sourceAuthorId}`);
  }
  for (const relation of records.workTags) {
    if (!workIds.has(relation.sourceWorkId)) throw new PackageValidationError(`Work-tag references missing work ${relation.sourceWorkId}`);
    if (!tagIds.has(relation.sourceTagId)) throw new PackageValidationError(`Work-tag references missing tag ${relation.sourceTagId}`);
  }
  for (const relation of records.seriesWorks) {
    if (!workIds.has(relation.sourceWorkId)) throw new PackageValidationError(`Series-work references missing work ${relation.sourceWorkId}`);
    if (!seriesIds.has(relation.sourceSeriesId)) throw new PackageValidationError(`Series-work references missing series ${relation.sourceSeriesId}`);
  }
}

function expectedCounts(records: TransferRecords): Manifest["records"] {
  return {
    authors: records.authors.length,
    workAuthors: records.workAuthors.length,
    works: records.works.length,
    chapters: records.chapters.length,
    tags: records.tags.length,
    workTags: records.workTags.length,
    series: records.series.length,
    seriesWorks: records.seriesWorks.length,
    observations: records.observations.length,
  };
}

export async function writeTransferPackage(directory: string, transfer: TransferPackage): Promise<void> {
  const manifest = ManifestSchema.parse(transfer.manifest);
  validateReferences(transfer.records);
  const counts = expectedCounts(transfer.records);
  if (JSON.stringify(manifest.records) !== JSON.stringify(counts)) {
    throw new PackageValidationError(`Manifest record counts do not match supplied records`);
  }

  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });

  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  for (const fileName of orderedDataFiles) {
    const records = transfer.records[fileToRecordKey[fileName]];
    await writeFile(join(directory, fileName), records.map(jsonLine).join(""), "utf8");
  }

  const checksumLines: string[] = [];
  for (const fileName of checksumFiles) {
    const content = await readFile(join(directory, fileName));
    checksumLines.push(`${sha256(content)}  ${fileName}`);
  }
  await writeFile(join(directory, "checksums.sha256"), `${checksumLines.join("\n")}\n`, "utf8");
}

export async function readTransferPackage(directory: string): Promise<TransferPackage> {
  await verifyChecksums(directory);
  const manifestText = await readFile(join(directory, "manifest.json"), "utf8");
  const manifest = ManifestSchema.parse(JSON.parse(manifestText));

  const records = {} as TransferRecords;
  for (const fileName of orderedDataFiles) {
    const content = await readFile(join(directory, fileName), "utf8");
    const schema = RecordSchemas[fileName] as ZodType<unknown>;
    (records as unknown as Record<string, unknown>)[fileToRecordKey[fileName]] = parseJsonLines(content, schema, fileName);
  }

  validateReferences(records);
  const counts = expectedCounts(records);
  if (JSON.stringify(manifest.records) !== JSON.stringify(counts)) {
    throw new PackageValidationError(`Manifest record counts do not match package contents`);
  }
  return { manifest, records };
}

export async function verifyChecksums(directory: string): Promise<void> {
  const checksumText = await readFile(join(directory, "checksums.sha256"), "utf8");
  const expected = new Map<string, string>();
  for (const line of checksumText.trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  ([a-z0-9.-]+)$/);
    if (!match?.[1] || !match[2]) throw new PackageValidationError(`Invalid checksum line: ${line}`);
    expected.set(match[2], match[1]);
  }

  for (const fileName of checksumFiles) {
    const wanted = expected.get(fileName);
    if (!wanted) throw new PackageValidationError(`Missing checksum for ${fileName}`);
    const actual = sha256(await readFile(join(directory, fileName)));
    if (wanted !== actual) throw new PackageValidationError(`Checksum mismatch for ${fileName}`);
  }
}
