import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { and, asc, count, desc, eq, inArray, like, or, sql } from "drizzle-orm";
import { CollectorStore, ExportQueueStore, TaskLeaseStore } from "@ao3-offsite/collector";
import {
  authors,
  bookmarks,
  chapters,
  collectionJobs,
  collectionTasks,
  comments,
  exportRuns,
  fetchSnapshots,
  kudos,
  series,
  seriesWorks,
  sourceDailyUsage,
  sources,
  tags,
  workAuthors,
  works,
  workTags,
  type CollectorDatabase,
} from "@ao3-offsite/database";

export interface SourceUpdate {
  userAgent: string;
  includeAdult: boolean;
  minimumDelayMs: number;
  dailyRequestBudget: number | null;
  dailyByteBudget: number | null;
  requestTimeoutMs: number;
  maximumResponseBytes: number;
  maximumFailureAttempts: number;
  operatingWindowStartHourUtc: number | null;
  operatingWindowEndHourUtc: number | null;
  captureComments: boolean;
  captureKudos: boolean;
  captureBookmarks: boolean;
  maximumCommentPages: number | null;
  maximumKudosPages: number | null;
  maximumBookmarkPages: number | null;
  paused: boolean;
}

export type SourceCreate = Omit<SourceUpdate, "paused"> & { key: string; origin: string };

export interface CollectorStatistics {
  works: number;
  words: number;
  chapters: number;
  authors: number;
  activeJobs: number;
  terminalFailures: number;
}

export interface SystemSettings {
  backupRetentionDays: number | null;
  defaultBatchSize: number;
  timezone: string;
}

export type SettingsUpdate = {
  backupRetentionDays?: number | null | undefined;
  defaultBatchSize?: number | undefined;
  timezone?: string | undefined;
};

export interface ApiServices {
  ready(): Promise<boolean>;
  listSources(): Promise<unknown[]>;
  createSource(input: SourceCreate): Promise<number>;
  updateSource(sourceId: number, update: SourceUpdate): Promise<boolean>;
  createIdRangeJob(sourceId: number, configuration: { start: number; end: number; batchSize: number }): Promise<number>;
  listJobs(limit: number, offset: number): Promise<unknown[]>;
  getJob(jobId: number): Promise<unknown | null>;
  pauseJob(jobId: number): Promise<void>;
  resumeJob(jobId: number): Promise<void>;
  cancelJob(jobId: number): Promise<void>;
  retryJobFailures(jobId: number): Promise<void>;
  listFailures(limit: number, offset: number): Promise<{ items: unknown[]; total: number }>;
  createExport(sourceId: number, maximumWorks: number): Promise<{ id: number; packageId: string }>;
  listExports(limit: number, offset: number): Promise<{ items: unknown[]; total: number }>;
  getExport(exportId: number): Promise<unknown | null>;
  getExportManifest(exportId: number): Promise<unknown | null>;
  getExportDownload(exportId: number): Promise<{ path: string; fileName: string; hash: string; bytes: number } | null>;
  verifyExport(exportId: number): Promise<{ verified: boolean; archiveHash: string; currentHash: string; bytes: number } | null>;
  updateImportStatus(exportId: number, update: { status: "not_imported" | "importing" | "imported" | "failed"; error?: string | null | undefined; otwImportRunId?: string | null | undefined }): Promise<boolean>;
  updateImportStatusByPackage(packageId: string, update: { status: "not_imported" | "importing" | "imported" | "failed"; error?: string | null | undefined; otwImportRunId?: string | null | undefined }): Promise<boolean>;
  listWorks(limit: number, offset: number, query: string): Promise<{ items: unknown[]; total: number }>;
  getWork(workId: number): Promise<unknown | null>;
  getChapter(workId: number, chapterId: number): Promise<unknown | null>;
  getSettings(): Promise<SystemSettings>;
  updateSettings(update: SettingsUpdate): Promise<SystemSettings>;
  getSystemInfo(): Promise<{ dataDirectory: string; exportDirectory: string }>;
  listFetches(limit: number, offset: number): Promise<{ items: unknown[]; total: number }>;
  statistics(): Promise<CollectorStatistics>;
}

export class MariaDbApiServices implements ApiServices {
  private readonly collector: CollectorStore;
  private readonly leases: TaskLeaseStore;
  private readonly exports: ExportQueueStore;

  constructor(private readonly db: CollectorDatabase, private readonly exportRoot = "./data/exports") {
    this.collector = new CollectorStore(db);
    this.leases = new TaskLeaseStore(db);
    this.exports = new ExportQueueStore(db);
  }

  async ready(): Promise<boolean> {
    await this.db.select({ id: sources.id }).from(sources).limit(1);
    return true;
  }

  async listSources(): Promise<unknown[]> {
    const rows = await this.db.select().from(sources).orderBy(asc(sources.id));
    const usageDate = new Date().toISOString().slice(0, 10);
    const usageRows = await this.db.select({
      sourceId: sourceDailyUsage.sourceId,
      requestCount: sourceDailyUsage.requestCount,
      responseBytes: sourceDailyUsage.responseBytes,
    }).from(sourceDailyUsage).where(eq(sourceDailyUsage.usageDate, usageDate));
    const usageBySource = new Map(usageRows.map((row) => [row.sourceId, row]));
    return rows.map((row) => ({
      ...row,
      todayUsage: {
        requests: usageBySource.get(row.id)?.requestCount ?? 0,
        bytes: usageBySource.get(row.id)?.responseBytes ?? 0,
      },
    }));
  }

  private get settingsFile(): string {
    return join(dirname(this.exportRoot), "system.json");
  }

  async getSettings(): Promise<SystemSettings> {
    return readSystemSettings(this.settingsFile);
  }

  async updateSettings(update: SettingsUpdate): Promise<SystemSettings> {
    const current = await readSystemSettings(this.settingsFile);
    const next: SystemSettings = {
      backupRetentionDays: update.backupRetentionDays !== undefined ? update.backupRetentionDays : current.backupRetentionDays,
      defaultBatchSize: update.defaultBatchSize !== undefined ? update.defaultBatchSize : current.defaultBatchSize,
      timezone: update.timezone !== undefined ? update.timezone : current.timezone,
    };
    await writeFile(this.settingsFile, JSON.stringify({ version: 1, ...next }, null, 2));
    return next;
  }

  async getSystemInfo(): Promise<{ dataDirectory: string; exportDirectory: string }> {
    return { dataDirectory: dirname(this.exportRoot), exportDirectory: this.exportRoot };
  }

  async listFetches(limit: number, offset: number): Promise<{ items: unknown[]; total: number }> {
    const rows = await this.db.select({
      id: fetchSnapshots.id,
      sourceWorkId: fetchSnapshots.sourceWorkId,
      url: fetchSnapshots.url,
      httpStatus: fetchSnapshots.httpStatus,
      fetchedAt: fetchSnapshots.fetchedAt,
      parserVersion: fetchSnapshots.parserVersion,
      responseHeaders: fetchSnapshots.responseHeaders,
      attempts: fetchSnapshots.attempts,
    }).from(fetchSnapshots).orderBy(desc(fetchSnapshots.fetchedAt)).limit(limit).offset(offset);
    const totalRows = await this.db.select({ value: count() }).from(fetchSnapshots);
    return {
      items: rows.map((row) => ({
        id: row.id,
        sourceWorkId: row.sourceWorkId,
        url: row.url,
        httpStatus: row.httpStatus,
        fetchedAt: row.fetchedAt,
        parserVersion: row.parserVersion,
        responseBytes: parseContentLength(row.responseHeaders),
        attempts: row.attempts,
      })),
      total: totalRows[0]?.value ?? 0,
    };
  }

  async createSource(input: SourceCreate): Promise<number> {
    const result = await this.db.insert(sources).values({
      ...input,
      dailyRequestBudget: input.dailyRequestBudget === 0 ? null : input.dailyRequestBudget,
      dailyByteBudget: input.dailyByteBudget === 0 ? null : input.dailyByteBudget,
      paused: true,
    }).$returningId();
    const id = result[0]?.id;
    if (!id) throw new Error("Source creation did not return an ID");
    return id;
  }

  async updateSource(sourceId: number, update: SourceUpdate): Promise<boolean> {
    const result = await this.db.update(sources).set({
      ...update,
      dailyRequestBudget: update.dailyRequestBudget === 0 ? null : update.dailyRequestBudget,
      dailyByteBudget: update.dailyByteBudget === 0 ? null : update.dailyByteBudget,
      updatedAt: new Date(),
    }).where(eq(sources.id, sourceId));
    return affectedRows(result) === 1;
  }

  createIdRangeJob(sourceId: number, configuration: { start: number; end: number; batchSize: number }): Promise<number> {
    return this.collector.createIdRangeJob(sourceId, configuration);
  }

  async listJobs(limit: number, offset: number): Promise<unknown[]> {
    return this.db.select().from(collectionJobs).orderBy(desc(collectionJobs.id)).limit(limit).offset(offset);
  }

  async getJob(jobId: number): Promise<unknown | null> {
    const job = (await this.db.select().from(collectionJobs).where(eq(collectionJobs.id, jobId)).limit(1))[0];
    if (!job) return null;
    const counts = await this.db.select({ status: collectionTasks.status, value: count() })
      .from(collectionTasks).where(eq(collectionTasks.jobId, jobId)).groupBy(collectionTasks.status);
    return { ...job, taskCounts: Object.fromEntries(counts.map((row) => [row.status, row.value])) };
  }

  pauseJob(jobId: number): Promise<void> { return this.leases.pauseJob(jobId); }
  resumeJob(jobId: number): Promise<void> { return this.leases.resumeJob(jobId); }
  cancelJob(jobId: number): Promise<void> { return this.leases.cancelJob(jobId); }
  retryJobFailures(jobId: number): Promise<void> { return this.leases.retryFailures(jobId); }

  async listFailures(limit: number, offset: number): Promise<{ items: unknown[]; total: number }> {
    const failureStates = ["retryable_failed", "terminal_failed"] as const;
    const items = await this.db.select({
      taskId: collectionTasks.id,
      jobId: collectionTasks.jobId,
      sourceWorkId: collectionTasks.sourceWorkId,
      status: collectionTasks.status,
      attempts: collectionTasks.attempts,
      errorCode: collectionTasks.lastErrorCode,
      errorMessage: collectionTasks.lastErrorMessage,
      availableAt: collectionTasks.availableAt,
      updatedAt: collectionTasks.updatedAt,
    }).from(collectionTasks).where(inArray(collectionTasks.status, [...failureStates]))
      .orderBy(desc(collectionTasks.updatedAt)).limit(limit).offset(offset);
    const total = (await this.db.select({ value: count() }).from(collectionTasks)
      .where(inArray(collectionTasks.status, [...failureStates])))[0]?.value ?? 0;
    return { items, total };
  }

  createExport(sourceId: number, maximumWorks: number): Promise<{ id: number; packageId: string }> {
    return this.exports.createRequest(sourceId, this.exportRoot, maximumWorks);
  }

  async listExports(limit: number, offset: number): Promise<{ items: unknown[]; total: number }> {
    const items = await this.db.select().from(exportRuns).orderBy(desc(exportRuns.id)).limit(limit).offset(offset);
    const total = (await this.db.select({ value: count() }).from(exportRuns))[0]?.value ?? 0;
    return { items, total };
  }

  getExport(exportId: number): Promise<unknown | null> {
    return this.db.select().from(exportRuns).where(eq(exportRuns.id, exportId)).limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async getExportManifest(exportId: number): Promise<unknown | null> {
    const row = (await this.db.select({
      status: exportRuns.status,
      outputDirectory: exportRuns.outputDirectory,
      archiveHash: exportRuns.archiveHash,
      archiveBytes: exportRuns.archiveBytes,
      verifiedAt: exportRuns.verifiedAt,
    }).from(exportRuns).where(eq(exportRuns.id, exportId)).limit(1))[0];
    if (!row || row.status !== "completed") return null;
    const [manifest, checksums] = await Promise.all([
      readFile(join(row.outputDirectory, "manifest.json"), "utf8").then(JSON.parse),
      readFile(join(row.outputDirectory, "checksums.sha256"), "utf8"),
    ]);
    return { manifest, checksums, archiveHash: row.archiveHash, archiveBytes: row.archiveBytes, verifiedAt: row.verifiedAt };
  }

  async getExportDownload(exportId: number): Promise<{ path: string; fileName: string; hash: string; bytes: number } | null> {
    const row = (await this.db.select({
      status: exportRuns.status,
      archivePath: exportRuns.archivePath,
      archiveHash: exportRuns.archiveHash,
      archiveBytes: exportRuns.archiveBytes,
    }).from(exportRuns).where(eq(exportRuns.id, exportId)).limit(1))[0];
    if (!row || row.status !== "completed" || !row.archivePath || !row.archiveHash || row.archiveBytes === null) return null;
    return { path: row.archivePath, fileName: basename(row.archivePath), hash: row.archiveHash, bytes: row.archiveBytes };
  }

  async verifyExport(exportId: number): Promise<{ verified: boolean; archiveHash: string; currentHash: string; bytes: number } | null> {
    const row = (await this.db.select({
      status: exportRuns.status,
      archivePath: exportRuns.archivePath,
      archiveHash: exportRuns.archiveHash,
      archiveBytes: exportRuns.archiveBytes,
    }).from(exportRuns).where(eq(exportRuns.id, exportId)).limit(1))[0];
    if (!row || row.status !== "completed" || !row.archivePath || !row.archiveHash) return null;
    const currentHash = `sha256:${await sha256File(row.archivePath)}`;
    return { verified: currentHash === row.archiveHash, archiveHash: row.archiveHash, currentHash, bytes: row.archiveBytes ?? 0 };
  }

  async updateImportStatusByPackage(packageId: string, update: { status: "not_imported" | "importing" | "imported" | "failed"; error?: string | null | undefined; otwImportRunId?: string | null | undefined }): Promise<boolean> {
    const row = (await this.db.select({ id: exportRuns.id }).from(exportRuns).where(eq(exportRuns.packageId, packageId)).limit(1))[0];
    return row ? this.updateImportStatus(row.id, update) : false;
  }

  async updateImportStatus(exportId: number, update: { status: "not_imported" | "importing" | "imported" | "failed"; error?: string | null | undefined; otwImportRunId?: string | null | undefined }): Promise<boolean> {
    const now = new Date();
    const result = await this.db.update(exportRuns).set({
      importStatus: update.status,
      importStartedAt: update.status === "importing" ? now : undefined,
      importedAt: update.status === "imported" ? now : null,
      importError: update.status === "failed" ? update.error ?? "OTW import failed" : null,
      otwImportRunId: update.otwImportRunId ?? null,
      updatedAt: now,
    }).where(eq(exportRuns.id, exportId));
    return affectedRows(result) === 1;
  }

  async listWorks(limit: number, offset: number, query: string): Promise<{ items: unknown[]; total: number }> {
    const filter = query
      ? or(like(works.title, `%${query}%`), like(works.sourceWorkId, `%${query}%`))
      : undefined;
    const base = this.db.select({
      id: works.id,
      sourceWorkId: works.sourceWorkId,
      title: works.title,
      languageCode: works.languageCode,
      complete: works.complete,
      expectedChapters: works.expectedChapters,
      words: works.words,
      availability: works.availability,
      sourceUpdatedAt: works.sourceUpdatedAt,
      lastSeenAt: works.lastSeenAt,
    }).from(works);
    const items = filter
      ? await base.where(filter).orderBy(desc(works.id)).limit(limit).offset(offset)
      : await base.orderBy(desc(works.id)).limit(limit).offset(offset);
    const totalRows = filter
      ? await this.db.select({ value: count() }).from(works).where(filter)
      : await this.db.select({ value: count() }).from(works);
    return { items, total: totalRows[0]?.value ?? 0 };
  }

  async getWork(workId: number): Promise<unknown | null> {
    const work = (await this.db.select().from(works).where(eq(works.id, workId)).limit(1))[0];
    if (!work) return null;
    const [chapterRows, authorRows, tagRows, seriesRows, commentRows, kudosCount, bookmarkCount] = await Promise.all([
      this.db.select({
        id: chapters.id,
        sourceChapterId: chapters.sourceChapterId,
        position: chapters.position,
        title: chapters.title,
        wordCount: chapters.wordCount,
        contentHash: chapters.contentHash,
      }).from(chapters).where(eq(chapters.workId, workId)).orderBy(asc(chapters.position)),
      this.db.select({
        sourceAuthorId: authors.sourceAuthorId,
        name: authors.name,
        profileUrl: authors.profileUrl,
        anonymous: authors.anonymous,
        orphaned: authors.orphaned,
        position: workAuthors.position,
      }).from(workAuthors).innerJoin(authors, eq(authors.id, workAuthors.authorId))
        .where(eq(workAuthors.workId, workId)).orderBy(asc(workAuthors.position)),
      this.db.select({
        sourceTagId: tags.sourceTagId,
        type: tags.type,
        name: tags.name,
        canonical: tags.canonical,
        sourceUrl: tags.sourceUrl,
        position: workTags.position,
      }).from(workTags).innerJoin(tags, eq(tags.id, workTags.tagId))
        .where(eq(workTags.workId, workId)).orderBy(asc(workTags.position)),
      this.db.select({
        sourceSeriesId: series.sourceSeriesId,
        name: series.name,
        sourceUrl: series.sourceUrl,
        position: seriesWorks.position,
      }).from(seriesWorks).innerJoin(series, eq(series.id, seriesWorks.seriesId))
        .where(eq(seriesWorks.workId, workId)).orderBy(asc(seriesWorks.position)),
      this.db.select({
        sourceCommentId: comments.sourceCommentId,
        parentSourceCommentId: comments.parentSourceCommentId,
        authorName: comments.authorName,
        authorProfileUrl: comments.authorProfileUrl,
        postedAt: comments.postedAt,
        depth: comments.depth,
        fromWorkCreator: comments.fromWorkCreator,
        textHtml: comments.textHtml,
      }).from(comments)
        .where(and(eq(comments.workId, workId), eq(comments.hidden, false)))
        .orderBy(asc(comments.depth), asc(comments.id)),
      this.db.select({ value: count() }).from(kudos).where(eq(kudos.workId, workId)),
      this.db.select({ value: count() }).from(bookmarks).where(and(eq(bookmarks.workId, workId), eq(bookmarks.hidden, false))),
    ]);
    return {
      ...work,
      chapters: chapterRows,
      authors: authorRows,
      tags: tagRows,
      series: seriesRows,
      comments: commentRows,
      kudosCount: kudosCount[0]?.value ?? 0,
      bookmarksCount: bookmarkCount[0]?.value ?? 0,
    };
  }

  async getChapter(workId: number, chapterId: number): Promise<unknown | null> {
    return (await this.db.select({
      id: chapters.id,
      workId: chapters.workId,
      sourceChapterId: chapters.sourceChapterId,
      position: chapters.position,
      title: chapters.title,
      summaryHtml: chapters.summaryHtml,
      notesHtml: chapters.notesHtml,
      contentHtml: chapters.contentHtml,
      endNotesHtml: chapters.endNotesHtml,
      publishedAt: chapters.publishedAt,
      wordCount: chapters.wordCount,
    }).from(chapters).where(and(eq(chapters.id, chapterId), eq(chapters.workId, workId))).limit(1))[0] ?? null;
  }

  async statistics(): Promise<CollectorStatistics> {
    const [workStats] = await this.db.select({
      works: count(),
      words: sql<number>`coalesce(sum(${works.words}), 0)`,
    }).from(works);
    const [chapterStats] = await this.db.select({ chapters: count() }).from(chapters);
    const [authorStats] = await this.db.select({ authors: count() }).from(authors);
    const [jobStats] = await this.db.select({
      activeJobs: sql<number>`coalesce(sum(case when ${collectionJobs.status} in ('queued', 'running') then 1 else 0 end), 0)`,
      terminalFailures: sql<number>`coalesce(sum(${collectionJobs.failedCount}), 0)`,
    }).from(collectionJobs);
    return {
      works: workStats?.works ?? 0,
      words: Number(workStats?.words ?? 0),
      chapters: chapterStats?.chapters ?? 0,
      authors: authorStats?.authors ?? 0,
      activeJobs: Number(jobStats?.activeJobs ?? 0),
      terminalFailures: Number(jobStats?.terminalFailures ?? 0),
    };
  }
}

async function readSystemSettings(path: string): Promise<SystemSettings> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as Partial<SystemSettings>;
    return {
      backupRetentionDays: typeof parsed.backupRetentionDays === "number" ? parsed.backupRetentionDays : null,
      defaultBatchSize: typeof parsed.defaultBatchSize === "number" ? parsed.defaultBatchSize : 250,
      timezone: typeof parsed.timezone === "string" && parsed.timezone ? parsed.timezone : (process.env.TZ ?? "UTC"),
    };
  } catch {
    return { backupRetentionDays: null, defaultBatchSize: 250, timezone: process.env.TZ ?? "UTC" };
  }
}

function parseContentLength(headers: Record<string, string>): number | null {
  const value = headers["content-length"];
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on("data", (chunk) => { hash.update(chunk); });
    stream.on("error", reject);
    stream.on("end", () => resolve());
  });
  return hash.digest("hex");
}

function affectedRows(result: unknown): number {
  const candidate = Array.isArray(result) ? result[0] : result;
  return candidate && typeof candidate === "object" && "affectedRows" in candidate
    ? Number((candidate as { affectedRows: unknown }).affectedRows)
    : 0;
}
