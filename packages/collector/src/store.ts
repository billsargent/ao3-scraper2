import { createHash } from "node:crypto";
import { and, count, eq, notInArray } from "drizzle-orm";
import type { Observation, TransferRecords } from "@ao3-offsite/contracts";
import {
  authors,
  chapters,
  collectionJobs,
  collectionTasks,
  fetchSnapshots,
  observations,
  series,
  seriesWorks,
  tags,
  workAuthors,
  works,
  workTags,
  type CollectorDatabase,
} from "@ao3-offsite/database";

function requiredRow<T>(rows: T[], description: string): T {
  const row = rows[0];
  if (!row) throw new Error(`Expected ${description} after upsert`);
  return row;
}

export class CollectorStore {
  constructor(private readonly db: CollectorDatabase) {}

  async createIdRangeJob(sourceId: number, configuration: { start: number; end: number; batchSize: number }): Promise<number> {
    const result = await this.db.insert(collectionJobs).values({
      sourceId,
      type: "id_range",
      status: "queued",
      configuration,
    }).$returningId();
    const row = requiredRow(result, "created collection job");
    return row.id;
  }

  async enqueueWorkIds(jobId: number, sourceWorkIds: string[]): Promise<void> {
    if (sourceWorkIds.length === 0) return;
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.insert(collectionTasks)
        .values(sourceWorkIds.map((sourceWorkId) => ({ jobId, sourceWorkId, status: "queued" as const, availableAt: now })))
        .onDuplicateKeyUpdate({ set: { updatedAt: now } });
      const taskCount = requiredRow(
        await tx.select({ value: count() }).from(collectionTasks).where(eq(collectionTasks.jobId, jobId)),
        "collection task count",
      );
      await tx.update(collectionJobs)
        .set({ discoveredCount: taskCount.value, updatedAt: now })
        .where(eq(collectionJobs.id, jobId));
    });
  }

  async recordSnapshot(input: {
    sourceId: number;
    sourceWorkId: string;
    url: string;
    httpStatus: number;
    fetchedAt: Date;
    bodyHash: string;
    storageKey: string;
    responseHeaders: Record<string, string>;
    parserVersion?: string;
  }): Promise<void> {
    await this.db.insert(fetchSnapshots).values({
      ...input,
      urlHash: createHash("sha256").update(input.url).digest("hex"),
      parserVersion: input.parserVersion ?? null,
    }).onDuplicateKeyUpdate({ set: { parserVersion: input.parserVersion ?? null } });
  }

  async persistAvailability(sourceId: number, observation: Observation): Promise<void> {
    const observedAt = new Date(observation.observedAt);
    await this.db.transaction(async (tx) => {
      await tx.insert(observations).values({
        sourceId,
        sourceWorkId: observation.sourceWorkId,
        observedAt,
        availability: observation.availability,
        httpStatus: observation.httpStatus,
        sourceUpdatedAt: observation.sourceUpdatedAt,
        contentHash: observation.contentHash,
      }).onDuplicateKeyUpdate({ set: { availability: observation.availability, httpStatus: observation.httpStatus } });
      await tx.update(works).set({ availability: observation.availability, lastSeenAt: observedAt, updatedAt: observedAt })
        .where(and(eq(works.sourceId, sourceId), eq(works.sourceWorkId, observation.sourceWorkId)));
    });
  }

  async persistCapturedWork(sourceId: number, records: TransferRecords): Promise<number> {
    if (records.works.length !== 1) throw new Error("persistCapturedWork requires exactly one work");
    const record = records.works[0]!;
    const capturedAt = new Date(records.observations[0]?.observedAt ?? new Date().toISOString());

    return this.db.transaction(async (tx) => {
      await tx.insert(works).values({
        sourceId,
        sourceWorkId: record.sourceWorkId,
        sourceUrl: record.sourceUrl,
        title: record.title,
        summaryHtml: record.summaryHtml,
        notesHtml: record.notesHtml,
        endNotesHtml: record.endNotesHtml,
        languageCode: record.languageCode,
        publishedAt: record.publishedAt,
        sourceUpdatedAt: record.updatedAt,
        complete: record.complete,
        restricted: record.restricted,
        expectedChapters: record.expectedChapters,
        words: record.words,
        contentHash: record.contentHash,
        availability: "public",
        firstSeenAt: capturedAt,
        lastSeenAt: capturedAt,
        lastSuccessfulCaptureAt: capturedAt,
      }).onDuplicateKeyUpdate({ set: {
        sourceUrl: record.sourceUrl,
        title: record.title,
        summaryHtml: record.summaryHtml,
        notesHtml: record.notesHtml,
        endNotesHtml: record.endNotesHtml,
        languageCode: record.languageCode,
        publishedAt: record.publishedAt,
        sourceUpdatedAt: record.updatedAt,
        complete: record.complete,
        restricted: record.restricted,
        expectedChapters: record.expectedChapters,
        words: record.words,
        contentHash: record.contentHash,
        availability: "public",
        lastSeenAt: capturedAt,
        lastSuccessfulCaptureAt: capturedAt,
        updatedAt: capturedAt,
      }});

      const work = requiredRow(await tx.select({ id: works.id }).from(works).where(and(
        eq(works.sourceId, sourceId), eq(works.sourceWorkId, record.sourceWorkId),
      )).limit(1), "work");

      const authorIds = new Map<string, number>();
      for (const author of records.authors) {
        await tx.insert(authors).values({ sourceId, ...author }).onDuplicateKeyUpdate({ set: {
          name: author.name, profileUrl: author.profileUrl, anonymous: author.anonymous,
          orphaned: author.orphaned, updatedAt: capturedAt,
        }});
        const row = requiredRow(await tx.select({ id: authors.id }).from(authors).where(and(
          eq(authors.sourceId, sourceId), eq(authors.sourceAuthorId, author.sourceAuthorId),
        )).limit(1), `author ${author.sourceAuthorId}`);
        authorIds.set(author.sourceAuthorId, row.id);
      }
      await tx.delete(workAuthors).where(eq(workAuthors.workId, work.id));
      if (records.workAuthors.length > 0) {
        await tx.insert(workAuthors).values(records.workAuthors.map((relation) => ({
          workId: work.id,
          authorId: authorIds.get(relation.sourceAuthorId) ?? (() => { throw new Error(`Missing author ${relation.sourceAuthorId}`); })(),
          position: relation.position,
        })));
      }

      const chapterSourceIds = records.chapters.map((chapter) => chapter.sourceChapterId);
      if (chapterSourceIds.length > 0) {
        await tx.delete(chapters).where(and(eq(chapters.workId, work.id), notInArray(chapters.sourceChapterId, chapterSourceIds)));
      }
      for (const chapter of records.chapters) {
        await tx.insert(chapters).values({ workId: work.id, ...chapter }).onDuplicateKeyUpdate({ set: {
          position: chapter.position, title: chapter.title, summaryHtml: chapter.summaryHtml,
          notesHtml: chapter.notesHtml, contentHtml: chapter.contentHtml, endNotesHtml: chapter.endNotesHtml,
          publishedAt: chapter.publishedAt, wordCount: chapter.wordCount, contentHash: chapter.contentHash,
          updatedAt: capturedAt,
        }});
      }

      const tagIds = new Map<string, number>();
      for (const tag of records.tags) {
        await tx.insert(tags).values({ sourceId, ...tag }).onDuplicateKeyUpdate({ set: {
          type: tag.type, name: tag.name, canonical: tag.canonical, sourceUrl: tag.sourceUrl, updatedAt: capturedAt,
        }});
        const row = requiredRow(await tx.select({ id: tags.id }).from(tags).where(and(
          eq(tags.sourceId, sourceId), eq(tags.sourceTagId, tag.sourceTagId),
        )).limit(1), `tag ${tag.sourceTagId}`);
        tagIds.set(tag.sourceTagId, row.id);
      }
      await tx.delete(workTags).where(eq(workTags.workId, work.id));
      if (records.workTags.length > 0) {
        await tx.insert(workTags).values(records.workTags.map((relation) => ({
          workId: work.id,
          tagId: tagIds.get(relation.sourceTagId) ?? (() => { throw new Error(`Missing tag ${relation.sourceTagId}`); })(),
          position: relation.position,
        })));
      }

      for (const sourceSeries of records.series) {
        await tx.insert(series).values({ sourceId, ...sourceSeries }).onDuplicateKeyUpdate({ set: {
          sourceUrl: sourceSeries.sourceUrl, name: sourceSeries.name,
          summaryHtml: sourceSeries.summaryHtml, complete: sourceSeries.complete, updatedAt: capturedAt,
        }});
        const seriesRow = requiredRow(await tx.select({ id: series.id }).from(series).where(and(
          eq(series.sourceId, sourceId), eq(series.sourceSeriesId, sourceSeries.sourceSeriesId),
        )).limit(1), `series ${sourceSeries.sourceSeriesId}`);
        const relation = records.seriesWorks.find((candidate) => candidate.sourceSeriesId === sourceSeries.sourceSeriesId);
        if (relation) {
          await tx.insert(seriesWorks).values({ seriesId: seriesRow.id, workId: work.id, position: relation.position })
            .onDuplicateKeyUpdate({ set: { position: relation.position } });
        }
      }

      for (const observation of records.observations) {
        await tx.insert(observations).values({
          sourceId,
          sourceWorkId: observation.sourceWorkId,
          observedAt: new Date(observation.observedAt),
          availability: observation.availability,
          httpStatus: observation.httpStatus,
          sourceUpdatedAt: observation.sourceUpdatedAt,
          contentHash: observation.contentHash,
        }).onDuplicateKeyUpdate({ set: { contentHash: observation.contentHash } });
      }
      return work.id;
    });
  }
}
