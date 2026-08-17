import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { FORMAT_VERSION, type TransferRecords } from "@ao3-offsite/contracts";
import {
  authors,
  chapters,
  observations,
  series,
  seriesWorks,
  tags,
  workAuthors,
  works,
  workTags,
  type CollectorDatabase,
} from "@ao3-offsite/database";
import { writeTransferPackage } from "@ao3-offsite/package-tools";

export interface ExportOptions {
  sourceId: number;
  sourceKey: string;
  origin: string;
  sourceWorkIds: string[];
  outputDirectory: string;
  previousPackageId?: string | null;
}

export class MariaDbPackageExporter {
  constructor(private readonly db: CollectorDatabase) {}

  async export(options: ExportOptions): Promise<string> {
    if (options.sourceWorkIds.length === 0) throw new Error("At least one work ID is required for export");
    const selectedWorks = await this.db.select().from(works).where(and(
      eq(works.sourceId, options.sourceId), inArray(works.sourceWorkId, options.sourceWorkIds),
    ));
    if (selectedWorks.length !== new Set(options.sourceWorkIds).size) {
      const found = new Set(selectedWorks.map((work) => work.sourceWorkId));
      throw new Error(`Missing collected works: ${[...new Set(options.sourceWorkIds)].filter((id) => !found.has(id)).join(", ")}`);
    }
    const localWorkIds = selectedWorks.map((work) => work.id);
    const sourceByLocalWork = new Map(selectedWorks.map((work) => [work.id, work.sourceWorkId]));

    const chapterRows = await this.db.select().from(chapters)
      .where(inArray(chapters.workId, localWorkIds)).orderBy(asc(chapters.workId), asc(chapters.position));
    const authorRows = await this.db.select({ author: authors, workId: workAuthors.workId, position: workAuthors.position })
      .from(workAuthors).innerJoin(authors, eq(authors.id, workAuthors.authorId))
      .where(inArray(workAuthors.workId, localWorkIds)).orderBy(asc(workAuthors.workId), asc(workAuthors.position));
    const tagRows = await this.db.select({ tag: tags, workId: workTags.workId, position: workTags.position })
      .from(workTags).innerJoin(tags, eq(tags.id, workTags.tagId))
      .where(inArray(workTags.workId, localWorkIds)).orderBy(asc(workTags.workId), asc(workTags.position));
    const seriesRows = await this.db.select({ sourceSeries: series, workId: seriesWorks.workId, position: seriesWorks.position })
      .from(seriesWorks).innerJoin(series, eq(series.id, seriesWorks.seriesId))
      .where(inArray(seriesWorks.workId, localWorkIds)).orderBy(asc(seriesWorks.seriesId), asc(seriesWorks.position));
    const observationRows = await this.db.select().from(observations).where(and(
      eq(observations.sourceId, options.sourceId), inArray(observations.sourceWorkId, options.sourceWorkIds),
    )).orderBy(asc(observations.observedAt));

    const records: TransferRecords = {
      authors: unique(authorRows.map(({ author }) => ({
        sourceAuthorId: author.sourceAuthorId, name: author.name, profileUrl: author.profileUrl,
        anonymous: author.anonymous, orphaned: author.orphaned,
      })), (row) => row.sourceAuthorId),
      workAuthors: authorRows.map(({ author, workId, position }) => ({
        sourceWorkId: requiredMap(sourceByLocalWork, workId), sourceAuthorId: author.sourceAuthorId, position,
      })),
      works: selectedWorks.map((work) => ({
        operation: "upsert",
        sourceWorkId: work.sourceWorkId,
        sourceUrl: work.sourceUrl,
        title: work.title,
        summaryHtml: work.summaryHtml,
        languageCode: work.languageCode,
        publishedAt: work.publishedAt,
        updatedAt: work.sourceUpdatedAt,
        complete: work.complete,
        restricted: work.restricted,
        expectedChapters: work.expectedChapters,
        words: work.words,
        notesHtml: work.notesHtml,
        endNotesHtml: work.endNotesHtml,
        contentHash: work.contentHash as `sha256:${string}`,
      })),
      chapters: chapterRows.map((chapter) => ({
        sourceWorkId: requiredMap(sourceByLocalWork, chapter.workId),
        sourceChapterId: chapter.sourceChapterId,
        position: chapter.position,
        title: chapter.title,
        summaryHtml: chapter.summaryHtml,
        notesHtml: chapter.notesHtml,
        contentHtml: chapter.contentHtml,
        endNotesHtml: chapter.endNotesHtml,
        publishedAt: chapter.publishedAt,
        wordCount: chapter.wordCount,
        contentHash: chapter.contentHash as `sha256:${string}`,
      })),
      tags: unique(tagRows.map(({ tag }) => ({
        sourceTagId: tag.sourceTagId, type: tag.type, name: tag.name,
        canonical: tag.canonical, sourceUrl: tag.sourceUrl,
      })), (row) => row.sourceTagId),
      workTags: tagRows.map(({ tag, workId, position }) => ({
        sourceWorkId: requiredMap(sourceByLocalWork, workId), sourceTagId: tag.sourceTagId, position,
      })),
      series: unique(seriesRows.map(({ sourceSeries }) => ({
        sourceSeriesId: sourceSeries.sourceSeriesId,
        name: sourceSeries.name,
        sourceUrl: sourceSeries.sourceUrl,
        summaryHtml: sourceSeries.summaryHtml,
        complete: sourceSeries.complete,
      })), (row) => row.sourceSeriesId),
      seriesWorks: seriesRows.map(({ sourceSeries, workId, position }) => ({
        sourceSeriesId: sourceSeries.sourceSeriesId, sourceWorkId: requiredMap(sourceByLocalWork, workId), position,
      })),
      observations: observationRows.map((observation) => ({
        sourceWorkId: observation.sourceWorkId,
        observedAt: observation.observedAt.toISOString(),
        availability: observation.availability,
        httpStatus: observation.httpStatus,
        sourceUpdatedAt: observation.sourceUpdatedAt,
        contentHash: observation.contentHash as `sha256:${string}` | null,
      })),
    };

    const packageId = randomUUID();
    const previousPackageId = options.previousPackageId ?? null;
    await writeTransferPackage(options.outputDirectory, {
      manifest: {
        format: "ao3-offsite-transfer",
        formatVersion: FORMAT_VERSION,
        packageId,
        packageType: previousPackageId ? "incremental" : "snapshot",
        source: { key: options.sourceKey, origin: options.origin },
        createdAt: new Date().toISOString(),
        collectorVersion: "mariadb-exporter-v1",
        previousPackageId,
        records: {
          authors: records.authors.length, workAuthors: records.workAuthors.length,
          works: records.works.length, chapters: records.chapters.length,
          tags: records.tags.length, workTags: records.workTags.length,
          series: records.series.length, seriesWorks: records.seriesWorks.length,
          observations: records.observations.length,
        },
      },
      records,
    });
    return packageId;
  }
}

function unique<T>(values: T[], key: (value: T) => string): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const identity = key(value);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

function requiredMap<K, V>(map: Map<K, V>, key: K): V {
  const value = map.get(key);
  if (value === undefined) throw new Error(`Missing related work ${String(key)}`);
  return value;
}
