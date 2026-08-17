import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import type { ApiServices } from "./services.js";

const IdParams = z.object({ id: z.coerce.number().int().positive() });
const Pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().nonnegative().default(0),
});
const IdRangeBody = z.object({
  sourceId: z.number().int().positive(),
  start: z.number().int().positive(),
  end: z.number().int().positive(),
  batchSize: z.number().int().min(1).max(1000).default(250),
}).refine((body) => body.end >= body.start, { path: ["end"], message: "end must be >= start" })
  .refine((body) => body.end - body.start + 1 <= 10_000, { path: ["end"], message: "API range is limited to 10,000 works" });
const SourceCreateBody = z.object({
  key: z.string().regex(/^[a-z0-9_-]{1,100}$/),
  origin: z.string().url().transform((value) => new URL(value).origin)
    .refine((value) => value.startsWith("https://") || value.startsWith("http://127.0.0.1:"), "HTTPS origin required"),
  minimumDelayMs: z.number().int().min(2000).max(3_600_000).default(10000),
  dailyRequestBudget: z.number().int().min(1).max(100_000).nullable().default(250),
});
const SourceBody = z.object({
  minimumDelayMs: z.number().int().min(2000).max(3_600_000),
  dailyRequestBudget: z.number().int().min(1).max(100_000).nullable(),
  paused: z.boolean(),
});

export function buildApp(services: ApiServices): FastifyInstance {
  const app = Fastify({ logger: false });
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
  app.get("/api/works", async (request) => {
    const { limit, offset } = Pagination.parse(request.query);
    return { works: await services.listWorks(limit, offset), limit, offset };
  });
  app.get("/api/works/:id", async (request, reply) => {
    const { id } = IdParams.parse(request.params);
    const work = await services.getWork(id);
    return work ? { work } : reply.status(404).send({ error: "not_found" });
  });
  return app;
}
