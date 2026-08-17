import { timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { STANDARD_CHROME_USER_AGENT } from "@ao3-offsite/database";
import type { ApiServices } from "./services.js";

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().nonnegative().default(0),
});
const WorksQuery = Pagination.extend({ q: z.string().max(200).default("") });
const ChapterParams = z.object({
  id: z.coerce.number().int().positive(),
  chapterId: z.coerce.number().int().positive(),
});
const ExportBody = z.object({
  sourceId: z.number().int().positive(),
  maximumWorks: z.number().int().min(1).max(5000).default(500),
});
const IdRangeBody = z.object({
  sourceId: z.number().int().positive(),
  start: z.number().int().positive(),
  end: z.number().int().positive(),
  batchSize: z.number().int().min(1).max(1000).default(250),
}).refine((body) => body.end >= body.start, { path: ["end"], message: "end must be >= start" })
  .refine((body) => body.end - body.start + 1 <= 10_000_000, { path: ["end"], message: "A single planning request is limited to 10,000,000 IDs" });
const SourcePolicy = z.object({
  userAgent: z.string().min(10).max(1000).default(STANDARD_CHROME_USER_AGENT),
  includeAdult: z.boolean().default(true),
  minimumDelayMs: z.number().int().min(2000).max(3_600_000).default(10000),
  dailyRequestBudget: z.number().int().min(1).max(100_000).nullable().default(250),
  dailyByteBudget: z.number().int().min(1_048_576).max(Number.MAX_SAFE_INTEGER).nullable().default(1_073_741_824),
  requestTimeoutMs: z.number().int().min(5000).max(300_000).default(60_000),
  maximumResponseBytes: z.number().int().min(1024).max(104_857_600).default(20_971_520),
  maximumFailureAttempts: z.number().int().min(1).max(20).default(6),
  operatingWindowStartHourUtc: z.number().int().min(0).max(23).nullable().default(null),
  operatingWindowEndHourUtc: z.number().int().min(0).max(23).nullable().default(null),
}).superRefine((policy, context) => {
  if ((policy.operatingWindowStartHourUtc === null) !== (policy.operatingWindowEndHourUtc === null)) {
    context.addIssue({ code: "custom", path: ["operatingWindowStartHourUtc"], message: "Both operating-window hours must be set or both must be null" });
  }
});
const SourceCreateBody = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,100}$/),
  origin: z.string().url().transform((value) => new URL(value).origin)
    .refine((value) => value.startsWith("https://") || value.startsWith("http://127.0.0.1:"), "HTTPS origin required"),
}).and(SourcePolicy);
const SourceBody = SourcePolicy.and(z.object({ paused: z.boolean() }));

export interface ApiSecurityOptions { apiToken?: string }

export function buildApp(services: ApiServices, security: ApiSecurityOptions = {}): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (request, reply) => {
    if (!security.apiToken || request.url === "/api/health/live") return;
    const authorization = request.headers.authorization;
    const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!safeTokenEqual(supplied, security.apiToken)) {
      return reply.status(401).send({ error: "unauthorized" });
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      void reply.status(400).send({ error: "validation_error", issues: error.issues });
      return;
    }
    app.log.error(error);
    void reply.status(500).send({ error: "internal_error" });
  });

  app.get("/api/health/live", async () => ({ status: "ok" }));
  app.get("/api/health/ready", async (_request, reply) => {
    try {
      await services.ready();
      return { status: "ready" };
    } catch {
      return reply.status(503).send({ status: "not_ready" });
    }
  });
  app.get("/api/events", async (request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    let closed = false;
    const sendJobs = async () => {
      if (closed) return;
      try {
        const [jobs, exports] = await Promise.all([
          services.listJobs(100, 0),
          services.listExports(100, 0),
        ]);
        const observedAt = new Date().toISOString();
        response.write(encodeSse("jobs", { jobs, observedAt }));
        response.write(encodeSse("exports", { exports: exports.items, total: exports.total, observedAt }));
      } catch {
        response.write(encodeSse("system", { status: "database_unavailable", observedAt: new Date().toISOString() }));
      }
    };
    await sendJobs();
    const snapshotTimer = setInterval(() => void sendJobs(), 2_000);
    const heartbeatTimer = setInterval(() => { if (!closed) response.write(": heartbeat\n\n"); }, 15_000);
    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(snapshotTimer);
      clearInterval(heartbeatTimer);
    };
    response.on("close", cleanup);
    request.raw.on("aborted", cleanup);
  });
  app.get("/api/sources", async () => ({ sources: await services.listSources() }));
  app.post("/api/sources", async (request, reply) => {
    const sourceId = await services.createSource(SourceCreateBody.parse(request.body));
    return reply.status(201).send({ sourceId, paused: true });
  });
  app.put("/api/sources/:id", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const updated = await services.updateSource(id, SourceBody.parse(request.body));
    return updated ? { updated: true } : reply.status(404).send({ error: "not_found" });
  });
  app.post("/api/jobs/id-range", async (request, reply) => {
    const body = IdRangeBody.parse(request.body);
    const jobId = await services.createIdRangeJob(body.sourceId, {
      start: body.start, end: body.end, batchSize: body.batchSize,
    });
    return reply.status(201).send({ jobId });
  });
  app.get("/api/jobs", async (request) => {
    const { limit, offset } = Pagination.parse(request.query);
    return { jobs: await services.listJobs(limit, offset), limit, offset };
  });
  app.get("/api/jobs/:id", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const job = await services.getJob(id);
    return job ? { job } : reply.status(404).send({ error: "not_found" });
  });
  for (const [action, operation] of [
    ["pause", (id: number) => services.pauseJob(id)],
    ["resume", (id: number) => services.resumeJob(id)],
    ["cancel", (id: number) => services.cancelJob(id)],
  ] as const) {
    app.post(`/api/jobs/:id/${action}`, async (request) => {
      const { id } = IdParams.parse(request.params);
      await operation(id);
      return { updated: true };
    });
  }
  app.post("/api/jobs/:id/retry-failures", async (request) => {
    const { id } = IdParams.parse(request.params);
    await services.retryJobFailures(id);
    return { updated: true };
  });
  app.post("/api/exports", async (request, reply) => {
    const body = ExportBody.parse(request.body);
    const created = await services.createExport(body.sourceId, body.maximumWorks);
    return reply.status(202).send(created);
  });
  app.get("/api/exports", async (request) => {
    const { limit, offset } = Pagination.parse(request.query);
    const result = await services.listExports(limit, offset);
    return { exports: result.items, total: result.total, limit, offset };
  });
  app.get("/api/exports/:id", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const result = await services.getExport(id);
    return result ? { export: result } : reply.status(404).send({ error: "not_found" });
  });
  app.get("/api/failures", async (request) => {
    const { limit, offset } = Pagination.parse(request.query);
    const result = await services.listFailures(limit, offset);
    return { failures: result.items, total: result.total, limit, offset };
  });
  app.get("/api/works", async (request) => {
    const { limit, offset, q } = WorksQuery.parse(request.query);
    const result = await services.listWorks(limit, offset, q);
    return { works: result.items, total: result.total, limit, offset, q };
  });
  app.get("/api/works/:id", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const work = await services.getWork(id);
    return work ? { work } : reply.status(404).send({ error: "not_found" });
  });
  app.get("/api/works/:id/chapters/:chapterId", async (request, reply) => {
    const { id, chapterId } = ChapterParams.parse(request.params);
    const chapter = await services.getChapter(id, chapterId);
    return chapter ? { chapter } : reply.status(404).send({ error: "not_found" });
  });
  return app;
}

export function encodeSse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function safeTokenEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
