import { createHash } from "node:crypto";
import { and, count, eq, inArray, notInArray, sql } from "drizzle-orm";
import type { Observation, TransferRecords } from "@ao3-offsite/contracts";
import {
  authors,
  bookmarks,
  chapters,
  collectionJobs,
  collectionTasks,
  comments,
  fetchSnapshots,
  kudos,
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

function firstRow(result: unknown): Record<string, unknown> {
  const candidate = Array.isArray(result) ? result[0] : result;
  if (Array.isArray(candidate)) return (candidate[0] as Record<string, unknown>) ?? {};
  return (candidate as Record<string, unknown>) ?? {};
}

export interface GapCoverage {
  start: number;
  end: number;
  total: number;
  collected: number;
  attempted: number;
  notFound: number;
  missing: number;
}

export interface FillResult {
  jobId: number | null;
  enqueued: number;
  nextCursor: number | null;
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

  /**
   * Create a job whose tasks are pre-enqueued (no planning pass needed) for an
   * explicit list of source work IDs. Used for gap-filling.
   */
  async createExplicitIdsJob(sourceId: number, sourceWorkIds: string[]): Promise<number> {
    const result = await this.db.insert(collectionJobs).values({
      sourceId,
      type: "explicit_ids",
      status: "queued",
      planningStatus: "completed",
      configuration: { count: sourceWorkIds.length },
    }).$returningId();
    const jobId = requiredRow(result, "created explicit_ids job").id;
    await this.enqueueWorkIds(jobId, sourceWorkIds);
    return jobId;
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

  /**
   * Return the first `limit` work IDs in [start, end] that we have not yet
   * collected, queued anywhere, or recorded as not_found (AO3 never reuses
   * IDs, so a 404 means "skip forever"). Also returns the next cursor to scan
   * from, so a caller can advance a frontier without re-scanning.
   */
  async findGaps(sourceId: number, start: number, end: number, limit: number): Promise<{ ids: string[]; nextCursor: number | null }> {
    const ids: string[] = [];
    let cursor = start;
    const windowSize = Math.max(limit * 3, 3_000);
    const maxScanned = Math.max(limit * 10, 10_000);
    let scanned = 0;
    while (cursor <= end && ids.length < limit && scanned < maxScanned) {
      const windowEnd = Math.min(end, cursor + windowSize - 1);
      const handled = await this.handledIdsInWindow(sourceId, cursor, windowEnd);
      for (let id = cursor; id <= windowEnd && ids.length < limit && scanned < maxScanned; id += 1) {
        scanned += 1;
        if (!handled.has(id)) ids.push(String(id));
      }
      cursor = windowEnd + 1;
    }
    return { ids, nextCursor: cursor <= end ? cursor : null };
  }

  private async handledIdsInWindow(sourceId: number, start: number, end: number): Promise<Set<number>> {
    const set = new Set<number>();
    const inWindow = sql`+ 0 BETWEEN ${start} AND ${end}`;
    const worksRows = await this.db.select({ id: works.sourceWorkId }).from(works).where(and(
      eq(works.sourceId, sourceId), sql`${works.sourceWorkId} ${inWindow}`,
    ));
    for (const row of worksRows) set.add(Number(row.id));
    const notFoundRows = await this.db.select({ id: observations.sourceWorkId }).from(observations).where(and(
      eq(observations.sourceId, sourceId), eq(observations.availability, "not_found"), sql`${observations.sourceWorkId} ${inWindow}`,
    ));
    for (const row of notFoundRows) set.add(Number(row.id));
    const taskRows = await this.db.select({ id: collectionTasks.sourceWorkId }).from(collectionTasks).where(sql`${collectionTasks.sourceWorkId} ${inWindow}`);
    for (const row of taskRows) set.add(Number(row.id));
    return set;
  }

  async coverage(sourceId: number, start: number, end: number): Promise<GapCoverage> {
    const total = Math.max(0, end - start + 1);
    const row = firstRow(await this.db.execute(sql`
      SELECT
        (SELECT COUNT(*) FROM ${works} WHERE ${works.sourceId} = ${sourceId} AND ${works.sourceWorkId} + 0 BETWEEN ${start} AND ${end}) AS collected,
        (SELECT COUNT(*) FROM ${observations} WHERE ${observations.sourceId} = ${sourceId} AND ${observations.availability} = 'not_found' AND ${observations.sourceWorkId} + 0 BETWEEN ${start} AND ${end}) AS not_found,
        (SELECT COUNT(DISTINCT ${collectionTasks.sourceWorkId}) FROM ${collectionTasks} WHERE ${collectionTasks.sourceWorkId} + 0 BETWEEN ${start} AND ${end}) AS attempted,
        (SELECT COUNT(*) FROM (
          SELECT ${works.sourceWorkId} FROM ${works} WHERE ${works.sourceId} = ${sourceId} AND ${works.sourceWorkId} + 0 BETWEEN ${start} AND ${end}
          UNION
          SELECT ${observations.sourceWorkId} FROM ${observations} WHERE ${observations.sourceId} = ${sourceId} AND ${observations.availability} = 'not_found' AND ${observations.sourceWorkId} + 0 BETWEEN ${start} AND ${end}
          UNION
          SELECT ${collectionTasks.sourceWorkId} FROM ${collectionTasks} WHERE ${collectionTasks.sourceWorkId} + 0 BETWEEN ${start} AND ${end}
        ) AS handled) AS handled
    `));
    const collected = Number(row.collected ?? 0);
    const notFound = Number(row.not_found ?? 0);
    const attempted = Number(row.attempted ?? 0);
    const handled = Number(row.handled ?? 0);
    return { start, end, total, collected, attempted, notFound, missing: Math.max(0, total - handled) };
  }

  async countPendingTasks(sourceId: number): Promise<number> {
    const rows = await this.db.select({ value: count() }).from(collectionTasks)
      .innerJoin(collectionJobs, eq(collectionTasks.jobId, collectionJobs.id))
      .where(and(eq(collectionJobs.sourceId, sourceId), inArray(collectionTasks.status, ["queued", "retryable_failed"])));
    return rows[0]?.value ?? 0;
  }

  async recordSnapshot(input: {
    sourceId: number;
    sourceWorkId: string;
    url: string;
    httpStatus: number;
    fetchedAt: Date;
    bodyHash?: string | null;
    storageKey?: string | null;
    responseHeaders?: Record<string, string>;
    parserVersion?: string | null;
    attempts?: number;
  }): Promise<void> {
    await this.db.insert(fetchSnapshots).values({
      sourceId: input.sourceId,
      sourceWorkId: input.sourceWorkId,
      url: input.url,
      urlHash: createHash("sha256").update(input.url).digest("hex"),
      httpStatus: input.httpStatus,
      fetchedAt: input.fetchedAt,
      bodyHash: input.bodyHash ?? null,
      storageKey: input.storageKey ?? null,
      responseHeaders: input.responseHeaders ?? {},
      parserVersion: input.parserVersion ?? null,
      attempts: input.attempts ?? 1,
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
        // Some AO3 pages (e.g. multi-chapter view_full_work views, which repeat
        // the byline per chapter) can list the same author more than once. The
        // work_authors primary key is (work_id, author_id), so dedupe to one row
        // per author (keeping the lowest position) before inserting.
        const uniqueAuthors = new Map<string, { sourceAuthorId: string; position: number }>();
        for (const relation of records.workAuthors) {
          const existing = uniqueAuthors.get(relation.sourceAuthorId);
          if (!existing || relation.position < existing.position) uniqueAuthors.set(relation.sourceAuthorId, relation);
        }
        await tx.insert(workAuthors).values([...uniqueAuthors.values()].map((relation) => ({
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

      for (const comment of records.comments) {
        await tx.insert(comments).values({
          sourceId,
          workId: work.id,
          sourceCommentId: comment.sourceCommentId,
          parentSourceCommentId: comment.parentSourceCommentId,
          authorName: comment.authorName,
          authorProfileUrl: comment.authorProfileUrl,
          postedAt: comment.postedAt,
          depth: comment.depth,
          fromWorkCreator: comment.fromWorkCreator,
          textHtml: comment.textHtml,
          contentHash: comment.contentHash,
          hidden: false,
          firstSeenAt: capturedAt,
          lastSeenAt: capturedAt,
        }).onDuplicateKeyUpdate({ set: {
          parentSourceCommentId: comment.parentSourceCommentId,
          authorName: comment.authorName,
          authorProfileUrl: comment.authorProfileUrl,
          postedAt: comment.postedAt,
          depth: comment.depth,
          fromWorkCreator: comment.fromWorkCreator,
          textHtml: comment.textHtml,
          contentHash: comment.contentHash,
          hidden: false,
          lastSeenAt: capturedAt,
          updatedAt: capturedAt,
        }});
      }

      for (const kudo of records.kudos) {
        await tx.insert(kudos).values({
          sourceId,
          workId: work.id,
          sourceKudoId: kudo.sourceKudoId,
          authorName: kudo.authorName,
          authorProfileUrl: kudo.authorProfileUrl,
          observedAt: new Date(kudo.observedAt),
        }).onDuplicateKeyUpdate({ set: { updatedAt: capturedAt } });
      }

      for (const bookmark of records.bookmarks) {
        await tx.insert(bookmarks).values({
          sourceId,
          workId: work.id,
          sourceBookmarkId: bookmark.sourceBookmarkId,
          bookmarkerName: bookmark.bookmarkerName,
          bookmarkerProfileUrl: bookmark.bookmarkerProfileUrl,
          notesHtml: bookmark.notesHtml,
          tagsJson: bookmark.tags,
          sourceUpdatedAt: bookmark.updatedAt,
          contentHash: bookmark.contentHash,
          hidden: false,
        }).onDuplicateKeyUpdate({ set: {
          bookmarkerName: bookmark.bookmarkerName,
          bookmarkerProfileUrl: bookmark.bookmarkerProfileUrl,
          notesHtml: bookmark.notesHtml,
          tagsJson: bookmark.tags,
          sourceUpdatedAt: bookmark.updatedAt,
          contentHash: bookmark.contentHash,
          hidden: false,
          updatedAt: capturedAt,
        }});
      }
      return work.id;
    });
  }
}
