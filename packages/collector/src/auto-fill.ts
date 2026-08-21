import { eq, sql } from "drizzle-orm";
import { autoFill, type CollectorDatabase } from "@ao3-offsite/database";

export interface AutoFillConfig {
  sourceId: number;
  enabled: boolean;
  frontierStart: number;
  batchSize: number;
  lastJobId: number | null;
  lastRunAt: Date | null;
}

/**
 * Persists the per-source auto-fill configuration and frontier cursor so the
 * collector worker can keep topping up coverage without re-scanning work it
 * has already queued.
 */
export class AutoFillStore {
  constructor(private readonly db: CollectorDatabase) {}

  async get(sourceId: number): Promise<AutoFillConfig> {
    const row = (await this.db.select().from(autoFill).where(eq(autoFill.sourceId, sourceId)).limit(1))[0];
    if (!row) return { sourceId, enabled: false, frontierStart: 1, batchSize: 200, lastJobId: null, lastRunAt: null };
    return {
      sourceId,
      enabled: row.enabled,
      frontierStart: row.frontierStart,
      batchSize: row.batchSize,
      lastJobId: row.lastJobId,
      lastRunAt: row.lastRunAt,
    };
  }

  async update(sourceId: number, update: { enabled?: boolean | undefined; frontierStart?: number | undefined; batchSize?: number | undefined }): Promise<AutoFillConfig> {
    const now = new Date();
    await this.db.insert(autoFill).values({
      sourceId,
      enabled: update.enabled ?? false,
      frontierStart: update.frontierStart ?? 1,
      batchSize: update.batchSize ?? 200,
    }).onDuplicateKeyUpdate({
      set: {
        enabled: update.enabled ?? sql`${autoFill.enabled}`,
        frontierStart: update.frontierStart ?? sql`${autoFill.frontierStart}`,
        batchSize: update.batchSize ?? sql`${autoFill.batchSize}`,
        updatedAt: now,
      },
    });
    return this.get(sourceId);
  }

  async recordRun(sourceId: number, jobId: number, nextCursor: number | null): Promise<void> {
    const now = new Date();
    await this.db.update(autoFill).set({
      lastJobId: jobId,
      lastRunAt: now,
      frontierStart: nextCursor ?? sql`${autoFill.frontierStart}`,
      updatedAt: now,
    }).where(eq(autoFill.sourceId, sourceId));
  }
}
