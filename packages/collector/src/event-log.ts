import { desc, eq, lt } from "drizzle-orm";
import { workerEvents, type CollectorDatabase } from "@ao3-offsite/database";

export type EventService = "api" | "collector" | "planner" | "export" | "system";
export type EventLevel = "debug" | "info" | "warn" | "error";

export interface WorkerEventRow {
  id: number;
  service: EventService;
  workerId: string | null;
  level: EventLevel;
  event: string;
  message: string | null;
  context: Record<string, unknown> | null;
  createdAt: Date;
}

export interface EventInput {
  level?: EventLevel;
  event: string;
  message?: string;
  context?: Record<string, unknown>;
}

const RETENTION_DAYS = 14;

/**
 * Durable, structured event log shared by the API and every worker. Events
 * are written to MariaDB so the web UI can show one combined, per-service view
 * of what each process is doing without shelling into the container. Logging
 * never throws: if the write fails, the error is echoed to stdout and the
 * caller continues.
 */
export class EventLog {
  constructor(
    private readonly db: CollectorDatabase,
    private readonly defaults: { service: EventService; workerId?: string },
  ) {}

  async record(input: EventInput): Promise<void> {
    try {
      const result = await this.db.insert(workerEvents).values({
        service: this.defaults.service,
        workerId: this.defaults.workerId ?? null,
        level: input.level ?? "info",
        event: input.event,
        message: input.message ?? null,
        context: input.context ?? null,
      }).$returningId();
      const id = result[0]?.id;
      if (id !== undefined && id % 100 === 0) await this.prune();
    } catch (error) {
      console.error(JSON.stringify({
        event: "event_log_failed",
        service: this.defaults.service,
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  }

  async list(service: EventService | "all", limit = 100, offset = 0): Promise<WorkerEventRow[]> {
    return this.db.select({
      id: workerEvents.id,
      service: workerEvents.service,
      workerId: workerEvents.workerId,
      level: workerEvents.level,
      event: workerEvents.event,
      message: workerEvents.message,
      context: workerEvents.context,
      createdAt: workerEvents.createdAt,
    }).from(workerEvents)
      .where(service === "all" ? undefined : eq(workerEvents.service, service))
      .orderBy(desc(workerEvents.id))
      .limit(limit)
      .offset(offset);
  }

  private async prune(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000);
    await this.db.delete(workerEvents).where(lt(workerEvents.createdAt, cutoff));
  }
}
