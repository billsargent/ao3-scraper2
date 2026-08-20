import { timingSafeEqual } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import fastifyStatic from "@fastify/static";
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
const PackageParams = z.object({ packageId: z.string().uuid() });
const ExportBody = z.object({
  sourceId: z.number().int().positive(),
  maximumWorks: z.number().int().min(1).max(5000).default(500),
});
const ImportStatusBody = z.object({
  status: z.enum(["not_imported", "importing", "imported", "failed"]),
  error: z.string().max(5000).nullable().optional(),
  otwImportRunId: z.string().max(255).nullable().optional(),
});
const SettingsBody = z.object({
  backupRetentionDays: z.number().int().nonnegative().nullable().optional(),
  defaultBatchSize: z.number().int().min(1).max(1000).optional(),
  timezone: z.string().min(1).max(64).optional(),
});
const IdRangeBody = z.object({
  sourceId: z.number().int().positive(),
  start: z.number().int().positive(),
  end: z.number().int().positive(),
  batchSize: z.number().int().min(1).max(1000).default(250),
}).refine((body) => body.end >= body.start, { path: ["end"], message: "end must be >= start" })
  .refine((body) => body.end - body.start + 1 <= 10_000_000, {
    path: ["end"],
    message: "A single planning request covers at most 10,000,000 IDs; use a later starting ID for recent works or create multiple jobs.",
  });
const SourcePolicy = z.object({
  userAgent: z.string().min(10).max(1000).default(STANDARD_CHROME_USER_AGENT),
  includeAdult: z.boolean().default(true),
  minimumDelayMs: z.number().int().nonnegative().default(10000),
  dailyRequestBudget: z.number().int().nonnegative().nullable().default(250),
  dailyByteBudget: z.number().int().nonnegative().nullable().default(1_073_741_824),
  requestTimeoutMs: z.number().int().nonnegative().default(60_000),
  maximumResponseBytes: z.number().int().nonnegative().default(20_971_520),
  maximumFailureAttempts: z.number().int().nonnegative().default(6),
  operatingWindowStartHourUtc: z.number().int().min(0).max(23).nullable().default(null),
  operatingWindowEndHourUtc: z.number().int().min(0).max(23).nullable().default(null),
  captureComments: z.boolean().default(false),
  captureKudos: z.boolean().default(false),
  captureBookmarks: z.boolean().default(false),
  maximumCommentPages: z.number().int().nonnegative().nullable().default(null),
  maximumKudosPages: z.number().int().nonnegative().nullable().default(null),
  maximumBookmarkPages: z.number().int().nonnegative().nullable().default(null),
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

export interface ApiSecurityOptions { apiToken?: string; logger?: boolean; commit?: string; webRoot?: string }

export function buildApp(services: ApiServices, security: ApiSecurityOptions = {}): FastifyInstance {
  const app = Fastify({ logger: security.logger ?? false });
  app.addHook("onRequest", async (request, reply) => {
    // Only the /api routes require the token. The React UI under / is public
    // so the unlock screen can load, and /api/health/live stays public as the
    // connectivity probe the unlock screen uses. /healthz is the container
    // healthcheck and is outside /api.
    const isApi = request.url.startsWith("/api");
    if (!security.apiToken || !isApi || request.url === "/api/health/live" || request.url === "/healthz") return;
    const authorization = request.headers.authorization;
    const supplied = authorization?.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!safeTokenEqual(supplied, security.apiToken)) {
      return reply.status(401).send({ error: "unauthorized" });
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      void reply.status(400).send({
        error: "validation_error",
        message: "One or more fields are invalid.",
        issues: error.issues,
        requestId: request.id,
      });
      return;
    }
    request.log.error({ err: error, requestId: request.id }, "API request failed");
    void reply.status(500).send({
      error: "internal_error",
      message: error instanceof Error && error.message ? error.message : "The server could not complete the request.",
      requestId: request.id,
    });
  });

  // Serve the built React UI in the single-container layout: static files at /
  // (served by the API itself instead of a separate Nginx container), /healthz
  // for the container healthcheck, SPA fallback to index.html, and the same
  // security headers the removed Nginx container used to set.
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header("Content-Security-Policy", "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    return payload;
  });
  if (security.webRoot && existsSync(security.webRoot)) {
    void app.register(fastifyStatic, { root: security.webRoot, prefix: "/", wildcard: false });
  }
  app.get("/healthz", async () => ({ ok: true }));
  app.setNotFoundHandler(async (request, reply) => {
    if (request.method === "GET" && !request.url.startsWith("/api") && !request.url.startsWith("/healthz")) {
      const indexPath = security.webRoot ? join(security.webRoot, "index.html") : null;
      if (indexPath && existsSync(indexPath)) {
        reply.type("text/html; charset=utf-8");
        return reply.send(createReadStream(indexPath));
      }
    }
    return reply.code(404).send({ error: "not_found", requestId: request.id });
  });

  const commit = security.commit ?? "development";
  app.get("/api/health/live", async () => ({ status: "ok", commit }));
  app.get("/api/health/ready", async (_request, reply) => {
    try {
      await services.ready();
      return { status: "ready", commit };
    } catch {
      return reply.status(503).send({ status: "not_ready", commit });
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
  app.get("/api/statistics", async () => ({ statistics: await services.statistics() }));
  app.get("/api/settings", async () => ({
    settings: await services.getSettings(),
    system: { ...(await services.getSystemInfo()), authEnabled: Boolean(security.apiToken), appCommit: commit },
  }));
  app.put("/api/settings", async (request, reply) => {
    const update = SettingsBody.parse(request.body);
    return { settings: await services.updateSettings(update) };
  });
  app.get("/api/fetches", async (request) => {
    const { limit, offset } = Pagination.parse(request.query);
    const result = await services.listFetches(limit, offset);
    return { fetches: result.items, total: result.total, limit, offset };
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
  app.delete("/api/jobs/:id", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const result = await services.deleteJob(id);
    if (result === "not_found") return reply.status(404).send({ error: "not_found" });
    if (result === "not_deletable") return reply.status(409).send({ error: "job_not_terminal", message: "Only completed, cancelled, or failed jobs can be deleted." });
    return { deleted: true };
  });
  app.post("/api/jobs/clear-cancelled", async () => ({ deleted: await services.clearCancelledJobs() }));
  app.post("/api/jobs/:id/retry-planning", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const result = await services.retryPlanning(id);
    if (result === "not_found") return reply.status(404).send({ error: "not_found" });
    if (result === "already_completed") return reply.status(409).send({ error: "planning_completed", message: "Planning is already complete." });
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
  app.get("/api/exports/:id/manifest", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const result = await services.getExportManifest(id);
    return result ? result : reply.status(404).send({ error: "artifact_not_ready" });
  });
  app.get("/api/exports/:id/download", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const artifact = await services.getExportDownload(id);
    if (!artifact) return reply.status(404).send({ error: "artifact_not_ready" });
    reply.header("content-type", "application/gzip");
    reply.header("content-disposition", `attachment; filename="${artifact.fileName}"`);
    reply.header("content-length", String(artifact.bytes));
    reply.header("x-content-sha256", artifact.hash);
    return reply.send(createReadStream(artifact.path));
  });
  app.post("/api/exports/:id/verify", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const result = await services.verifyExport(id);
    return result ? result : reply.status(404).send({ error: "not_found" });
  });
  app.patch("/api/exports/:id/import-status", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const updated = await services.updateImportStatus(id, ImportStatusBody.parse(request.body));
    return updated ? { updated: true } : reply.status(404).send({ error: "not_found" });
  });
  app.patch("/api/exports/by-package/:packageId/import-status", async (request, reply) => {
    const { packageId } = PackageParams.parse(request.params);
    const updated = await services.updateImportStatusByPackage(packageId, ImportStatusBody.parse(request.body));
    return updated ? { updated: true } : reply.status(404).send({ error: "not_found" });
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
