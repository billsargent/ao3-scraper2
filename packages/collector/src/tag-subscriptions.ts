import { and, eq } from "drizzle-orm";
import { tagSubscriptions, type CollectorDatabase } from "@ao3-offsite/database";

export type TagSubscription = typeof tagSubscriptions.$inferSelect;

export type TagType = "Rating" | "ArchiveWarning" | "Category" | "Fandom" | "Relationship" | "Character" | "Freeform";

/**
 * Persists the tags the operator has chosen to track for tag-based discovery.
 * Each subscription crawls its AO3 /tags/<slug>/works listing one page at a
 * time (newest first); the worker's tag auto-fill advances `nextPage` and
 * enqueues the discovered work IDs as explicit_ids jobs.
 */
export class TagSubscriptionStore {
  constructor(private readonly db: CollectorDatabase) {}

  async list(sourceId?: number): Promise<TagSubscription[]> {
    const rows = sourceId === undefined
      ? await this.db.select().from(tagSubscriptions).orderBy(tagSubscriptions.id)
      : await this.db.select().from(tagSubscriptions)
          .where(eq(tagSubscriptions.sourceId, sourceId)).orderBy(tagSubscriptions.id);
    return rows;
  }

  async listEnabled(sourceId: number): Promise<TagSubscription[]> {
    return this.db.select().from(tagSubscriptions)
      .where(and(eq(tagSubscriptions.sourceId, sourceId), eq(tagSubscriptions.enabled, true)))
      .orderBy(tagSubscriptions.id);
  }

  async subscribe(sourceId: number, input: { tagName: string; tagSlug: string; tagType: TagType }): Promise<TagSubscription> {
    const now = new Date();
    await this.db.insert(tagSubscriptions).values({
      sourceId,
      tagName: input.tagName,
      tagSlug: input.tagSlug,
      tagType: input.tagType,
      nextPage: 1,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    }).onDuplicateKeyUpdate({
      set: { tagName: input.tagName, tagType: input.tagType, updatedAt: now },
    });
    const row = (await this.db.select().from(tagSubscriptions)
      .where(and(eq(tagSubscriptions.sourceId, sourceId), eq(tagSubscriptions.tagSlug, input.tagSlug))).limit(1))[0];
    if (!row) throw new Error("Failed to upsert tag subscription");
    return row;
  }

  async unsubscribe(id: number): Promise<void> {
    await this.db.delete(tagSubscriptions).where(eq(tagSubscriptions.id, id));
  }

  async setEnabled(id: number, enabled: boolean): Promise<void> {
    await this.db.update(tagSubscriptions).set({ enabled, updatedAt: new Date() }).where(eq(tagSubscriptions.id, id));
  }

  async get(id: number): Promise<TagSubscription | null> {
    const row = (await this.db.select().from(tagSubscriptions).where(eq(tagSubscriptions.id, id)).limit(1))[0];
    return row ?? null;
  }

  async recordRun(id: number, nextPage: number, jobId: number | null): Promise<void> {
    const now = new Date();
    await this.db.update(tagSubscriptions).set({
      nextPage,
      lastJobId: jobId ?? undefined,
      lastRunAt: now,
      updatedAt: now,
    }).where(eq(tagSubscriptions.id, id));
  }
}
