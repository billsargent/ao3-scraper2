import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp, encodeSse } from "../src/app.js";
import type { ApiServices } from "../src/services.js";

function services(): ApiServices {
  return {
    ready: vi.fn().mockResolvedValue(true),
    listSources: vi.fn().mockResolvedValue([{ id: 1, origin: "https://archiveofourown.org" }]),
    createSource: vi.fn().mockResolvedValue(1),
    updateSource: vi.fn().mockResolvedValue(true),
    createIdRangeJob: vi.fn().mockResolvedValue(42),
    listJobs: vi.fn().mockResolvedValue([]),
    getJob: vi.fn().mockResolvedValue(null),
    pauseJob: vi.fn().mockResolvedValue(undefined),
    resumeJob: vi.fn().mockResolvedValue(undefined),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    retryJobFailures: vi.fn().mockResolvedValue(undefined),
    listFailures: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    createExport: vi.fn().mockResolvedValue({ id: 3, packageId: "00000000-0000-4000-8000-000000000003" }),
    listExports: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getExport: vi.fn().mockResolvedValue(null),
    getExportManifest: vi.fn().mockResolvedValue(null),
    getExportDownload: vi.fn().mockResolvedValue(null),
    updateImportStatus: vi.fn().mockResolvedValue(true),
    listWorks: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getWork: vi.fn().mockResolvedValue(null),
    getChapter: vi.fn().mockResolvedValue(null),
  };
}

const policy = {
  userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  includeAdult: true,
  minimumDelayMs: 10000,
  dailyRequestBudget: 250,
  dailyByteBudget: 1_073_741_824,
  requestTimeoutMs: 60_000,
  maximumResponseBytes: 20_971_520,
  maximumFailureAttempts: 6,
  operatingWindowStartHourUtc: null,
  operatingWindowEndHourUtc: null,
};

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("Fastify control API", () => {
  it("encodes standards-compatible named SSE events", () => {
    expect(encodeSse("jobs", { jobs: [{ id: 1 }] })).toBe('event: jobs\ndata: {"jobs":[{"id":1}]}\n\n');
  });
  it("enforces an optional bearer token while leaving liveness public", async () => {
    const token = "a-secure-test-token-that-is-at-least-32-characters";
    const app = buildApp(services(), { apiToken: token }); apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/health/live" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/sources" })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/sources", headers: { authorization: "Bearer wrong" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "GET", url: "/api/sources", headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  });

  it("reports process and database health", async () => {
    const app = buildApp(services()); apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/health/live" })).json()).toEqual({ status: "ok" });
    expect((await app.inject({ method: "GET", url: "/api/health/ready" })).json()).toEqual({ status: "ready" });
  });

  it("creates a bounded ID range job", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    const response = await app.inject({
      method: "POST", url: "/api/jobs/id-range",
      payload: { sourceId: 1, start: 100, end: 102, batchSize: 2 },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ jobId: 42 });
    expect(mock.createIdRangeJob).toHaveBeenCalledWith(1, { start: 100, end: 102, batchSize: 2 });
  });

  it("rejects invalid or excessively large ranges", async () => {
    const app = buildApp(services()); apps.push(app);
    const reversed = await app.inject({ method: "POST", url: "/api/jobs/id-range", payload: { sourceId: 1, start: 10, end: 1 } });
    expect(reversed.statusCode).toBe(400);
    const huge = await app.inject({ method: "POST", url: "/api/jobs/id-range", payload: { sourceId: 1, start: 1, end: 10_000_002 } });
    expect(huge.statusCode).toBe(400);
  });

  it("paginates and searches the library and exposes chapter routes", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/works?limit=10&offset=20&q=Potter" });
    expect(response.statusCode).toBe(200);
    expect(mock.listWorks).toHaveBeenCalledWith(10, 20, "Potter");
    expect(response.json()).toMatchObject({ total: 0, limit: 10, offset: 20, q: "Potter" });
    expect((await app.inject({ method: "GET", url: "/api/works/1/chapters/2" })).statusCode).toBe(404);
    expect(mock.getChapter).toHaveBeenCalledWith(1, 2);
  });

  it("queues and inspects asynchronous exports", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    const queued = await app.inject({ method: "POST", url: "/api/exports", payload: { sourceId: 1, maximumWorks: 100 } });
    expect(queued.statusCode).toBe(202);
    expect(mock.createExport).toHaveBeenCalledWith(1, 100);
    expect((await app.inject({ method: "GET", url: "/api/exports?limit=25&offset=0" })).json()).toMatchObject({ total: 0, exports: [] });
    expect((await app.inject({ method: "GET", url: "/api/exports/99" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/exports/99/manifest" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/exports/99/download" })).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url: "/api/exports/3/import-status", payload: { status: "imported", otwImportRunId: "run-3" } })).statusCode).toBe(200);
    expect(mock.updateImportStatus).toHaveBeenCalledWith(3, { status: "imported", otwImportRunId: "run-3" });
  });

  it("controls jobs and returns not found records", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    expect((await app.inject({ method: "POST", url: "/api/jobs/7/pause" })).statusCode).toBe(200);
    expect(mock.pauseJob).toHaveBeenCalledWith(7);
    expect((await app.inject({ method: "POST", url: "/api/jobs/7/retry-failures" })).statusCode).toBe(200);
    expect(mock.retryJobFailures).toHaveBeenCalledWith(7);
    expect((await app.inject({ method: "GET", url: "/api/failures?limit=10&offset=0" })).json()).toMatchObject({ total: 0, failures: [] });
    expect((await app.inject({ method: "GET", url: "/api/jobs/999" })).statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/api/works/999" })).statusCode).toBe(404);
  });

  it("creates sources paused with conservative defaults", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    const response = await app.inject({
      method: "POST", url: "/api/sources",
      payload: { key: "ao3", origin: "https://archiveofourown.org/path" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ sourceId: 1, paused: true });
    expect(mock.createSource).toHaveBeenCalledWith({ key: "ao3", origin: "https://archiveofourown.org", ...policy });
  });

  it("validates conservative source settings", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    const tooFast = await app.inject({
      method: "PUT", url: "/api/sources/1",
      payload: { ...policy, minimumDelayMs: 500, paused: false },
    });
    expect(tooFast.statusCode).toBe(400);
    const valid = await app.inject({
      method: "PUT", url: "/api/sources/1",
      payload: { ...policy, paused: true },
    });
    expect(valid.statusCode).toBe(200);
  });
});
