import { and, eq, sql } from "drizzle-orm";
import { sourceDailyUsage, sources, type CollectorDatabase } from "@ao3-offsite/database";

export type RequestReservation =
  | { granted: true; reservedAt: Date; nextRequestAt: Date; remainingToday: number | null }
  | { granted: false; reason: "paused" | "delay" | "daily_budget"; retryAt: Date | null };

export class SourceBudgetStore {
  constructor(private readonly db: CollectorDatabase) {}

  async reserveRequest(sourceId: number, now = new Date()): Promise<RequestReservation> {
    return this.db.transaction(async (tx) => {
      const source = (await tx.select().from(sources).where(eq(sources.id, sourceId)).limit(1).for("update"))[0];
      if (!source) throw new Error(`Unknown source ${sourceId}`);
      if (source.paused) return { granted: false, reason: "paused", retryAt: null };

      const usageDate = utcDate(now);
      await tx.insert(sourceDailyUsage).values({ sourceId, usageDate, requestCount: 0, responseBytes: 0 })
        .onDuplicateKeyUpdate({ set: { usageDate } });
      const usage = (await tx.select().from(sourceDailyUsage).where(and(
        eq(sourceDailyUsage.sourceId, sourceId), eq(sourceDailyUsage.usageDate, usageDate),
      )).limit(1).for("update"))[0]!;

      if (source.dailyRequestBudget !== null && usage.requestCount >= source.dailyRequestBudget) {
        return { granted: false, reason: "daily_budget", retryAt: nextUtcDay(now) };
      }
      if (source.nextRequestAt && source.nextRequestAt.getTime() > now.getTime()) {
        return { granted: false, reason: "delay", retryAt: source.nextRequestAt };
      }

      const nextRequestAt = new Date(now.getTime() + source.minimumDelayMs);
      await tx.update(sources).set({ nextRequestAt, updatedAt: now }).where(eq(sources.id, sourceId));
      await tx.update(sourceDailyUsage).set({
        requestCount: sql`${sourceDailyUsage.requestCount} + 1`,
        updatedAt: now,
      }).where(and(eq(sourceDailyUsage.sourceId, sourceId), eq(sourceDailyUsage.usageDate, usageDate)));
      const remainingToday = source.dailyRequestBudget === null ? null : source.dailyRequestBudget - usage.requestCount - 1;
      return { granted: true, reservedAt: now, nextRequestAt, remainingToday };
    });
  }

  async recordResponseBytes(sourceId: number, bytes: number, at = new Date()): Promise<void> {
    if (!Number.isSafeInteger(bytes) || bytes < 0) throw new Error("Response byte count must be a non-negative safe integer");
    const usageDate = utcDate(at);
    await this.db.insert(sourceDailyUsage).values({ sourceId, usageDate, requestCount: 0, responseBytes: bytes })
      .onDuplicateKeyUpdate({ set: {
        responseBytes: sql`${sourceDailyUsage.responseBytes} + ${bytes}`,
        updatedAt: at,
      }});
  }
}

export function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function nextUtcDay(value: Date): Date {
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate() + 1));
}
