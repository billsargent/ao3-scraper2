import { and, asc, count, desc, eq } from "drizzle-orm";
import { CollectorStore, TaskLeaseStore, planIdRange } from "@ao3-offsite/collector";
import {
  chapters,
  collectionJobs,
  collectionTasks,
  sources,
  works,
  type CollectorDatabase,
} from "@ao3-offsite/database";

export interface SourceUpdate {
  minimumDelayMs: number;
  dailyRequestBudget: number | null;
  paused: boolean;
}

export interface ApiServices {
  ready(): Promise<boolean>;
  listSources(): Promise<unknown[]>;
  createSource(input: { key: string; origin: string; minimumDelayMs: number; dailyRequestBudget: number | null }): Promise<number>;
  updateSource(sourceId: number, update: SourceUpdate): Promise<boolean>;
  createIdRangeJob(sourceId: number, configuration: { start: number; end: number; batchSize: number }): Promise<number>;
  listJobs(limit: number, offset: number): Promise<unknown[]>;
  getJob(jobId: number): Promise<unknown | null>;
  pauseJob(jobId: number): Promise<void>;
  resumeJob(jobId: number): Promise<void>;
  cancelJob(jobId: number): Promise<void>;
  listWorks(limit: number, offset: number): Promise<unknown[]>;
  getWork(workId: number): Promise<unknown | null>;
}

export class MariaDbApiServices implements ApiServices {
  private readonly collector: CollectorStore;
  private readonly leases: TaskLeaseStore;

  constructor(private readonly db: CollectorDatabase) {
    this.collector = new CollectorStore(db);
    this.leases = new TaskLeaseStore(db);
  }

  async ready(): Promise<boolean> {
    await this.db.select({ id: sources.id }).from(sources).limit(1);
    return true;
  }

  async listSources(): Promise<unknown[]> {
    return this.db.select().from(sources).orderBy(asc(sources.id));
  }

  async createSource(input: { key: string; origin: string; minimumDelayMs: number; dailyRequestBudget: number | null }): Promise<number> {
    const result = await this.db.insert(sources).values({ ...input, paused: true }).$returningId();
    const id = result[0]?.id;
    if (!id) throw new Error("Source creation did not return an ID");
    return id;
  }

  async updateSource(sourceId: number, update: SourceUpdate): Promise<boolean> {
    const result = await this.db.update(sources).set({ ...update, updatedAt: new Date() }).where(eq(sources.id, sourceId));
    return affectedRows(result) === 1;
  }

  async createIdRangeJob(sourceId: number, configuration: { start: number; end: number; batchSize: number }): Promise<number> {
    const jobId = await this.collector.createIdRangeJob(sourceId, configuration);
    for (const batch of planIdRange(configuration)) await this.collector.enqueueWorkIds(jobId, batch);
    return jobId;
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

  async listWorks(limit: number, offset: number): Promise<unknown[]> {
    return this.db.select({
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
    }).from(works).orderBy(desc(works.id)).limit(limit).offset(offset);
  }

  async getWork(workId: number): Promise<unknown | null> {
    const work = (await this.db.select().from(works).where(eq(works.id, workId)).limit(1))[0];
    if (!work) return null;
    const chapterRows = await this.db.select({
      id: chapters.id,
      sourceChapterId: chapters.sourceChapterId,
      position: chapters.position,
      title: chapters.title,
      wordCount: chapters.wordCount,
      contentHash: chapters.contentHash,
    }).from(chapters).where(and(eq(chapters.workId, workId))).orderBy(asc(chapters.position));
    return { ...work, chapters: chapterRows };
  }
}

function affectedRows(result: unknown): number {
  const candidate = Array.isArray(result) ? result[0] : result;
  return candidate && typeof candidate === "object" && "affectedRows" in candidate
    ? Number((candidate as { affectedRows: unknown }).affectedRows)
    : 0;
}
