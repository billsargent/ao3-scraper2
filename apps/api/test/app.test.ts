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
    deleteJob: vi.fn().mockResolvedValue("deleted"),
    clearCancelledJobs: vi.fn().mockResolvedValue(0),
    retryPlanning: vi.fn().mockResolvedValue("ok"),
    listFailures: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    createExport: vi.fn().mockResolvedValue({ id: 3, packageId: "00000000-0000-4000-8000-000000000003" }),
    listExports: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getExport: vi.fn().mockResolvedValue(null),
    getExportManifest: vi.fn().mockResolvedValue(null),
    getExportDownload: vi.fn().mockResolvedValue(null),
    verifyExport: vi.fn().mockResolvedValue({ verified: true, archiveHash: "sha256:abc", currentHash: "sha256:abc", bytes: 4096 }),
    updateImportStatus: vi.fn().mockResolvedValue(true),
    updateImportStatusByPackage: vi.fn().mockResolvedValue(true),
    listWorks: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getWork: vi.fn().mockResolvedValue(null),
    getChapter: vi.fn().mockResolvedValue(null),
    statistics: vi.fn().mockResolvedValue({ works: 0, words: 0, chapters: 0, authors: 0, activeJobs: 0, terminalFailures: 0 }),
    getSettings: vi.fn().mockResolvedValue({ backupRetentionDays: null, defaultBatchSize: 250, timezone: "UTC" }),
    updateSettings: vi.fn().mockResolvedValue({ backupRetentionDays: 30, defaultBatchSize: 250, timezone: "UTC" }),
    getSystemInfo: vi.fn().mockResolvedValue({ dataDirectory: "./data", exportDirectory: "./data/exports" }),
    listFetches: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    listEvents: vi.fn().mockResolvedValue([]),
    recordEvent: vi.fn().mockResolvedValue(undefined),
    gapCoverage: vi.fn().mockResolvedValue({ start: 1, end: 100, total: 100, collected: 10, attempted: 20, notFound: 5, missing: 70 }),
    fillGaps: vi.fn().mockResolvedValue({ jobId: 50, enqueued: 12, nextCursor: 101 }),
    getAutoFill: vi.fn().mockResolvedValue({ sourceId: 1, enabled: false, frontierStart: 1, batchSize: 200, lastJobId: null, lastRunAt: null }),
    updateAutoFill: vi.fn().mockResolvedValue({ sourceId: 1, enabled: true, frontierStart: 1, batchSize: 200, lastJobId: null, lastRunAt: null }),
    diagnostics: vi.fn().mockResolvedValue({ generatedAt: "2026-08-21T00:00:00.000Z", system: { dataDirectory: "./data", exportDirectory: "./data/exports" }, sources: [{ id: 1, key: "ao3" }], jobs: [], failures: [], logs: [] }),
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
  captureComments: false,
  captureKudos: false,
  captureBookmarks: false,
  maximumCommentPages: null,
  maximumKudosPages: null,
  maximumBookmarkPages: null,
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
  it("serves /api openly when no token is configured", async () => {
    const app = buildApp(services()); apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/sources" })).statusCode).toBe(200);
  });
  it("reads and updates system settings and lists AO3 fetches", async () => {
    const app = buildApp(services()); apps.push(app);
    const get = await app.inject({ method: "GET", url: "/api/settings" });
    expect(get.statusCode).toBe(200);
    expect(get.json()).toMatchObject({ settings: { backupRetentionDays: null, defaultBatchSize: 250 }, system: { dataDirectory: "./data", authEnabled: false } });
    const put = await app.inject({ method: "PUT", url: "/api/settings", payload: { backupRetentionDays: 30 } });
    expect(put.statusCode).toBe(200);
    expect(put.json().settings.backupRetentionDays).toBe(30);
    expect((await app.inject({ method: "GET", url: "/api/fetches" })).statusCode).toBe(200);
  });

  it("lists worker events filtered by service", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    const all = await app.inject({ method: "GET", url: "/api/logs" });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toMatchObject({ service: "all", limit: 25, offset: 0 });
    expect(mock.listEvents).toHaveBeenCalledWith("all", 25, 0);
    const planner = await app.inject({ method: "GET", url: "/api/logs?service=planner&limit=50" });
    expect(planner.statusCode).toBe(200);
    expect(mock.listEvents).toHaveBeenCalledWith("planner", 50, 0);
    expect((await app.inject({ method: "GET", url: "/api/logs?service=bogus" })).statusCode).toBe(400);
  });

  it("assembles a diagnostics snapshot with system metadata", async () => {
    const mock = services(); const app = buildApp(mock, { commit: "abc123" }); apps.push(app);
    const response = await app.inject({ method: "GET", url: "/api/diagnostics" });
    expect(response.statusCode).toBe(200);
    expect(mock.diagnostics).toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      system: { dataDirectory: "./data", authEnabled: false, appCommit: "abc123" },
      jobs: [], failures: [], logs: [],
    });
  });

  it("reports gap coverage and queues missing works", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    const gaps = await app.inject({ method: "GET", url: "/api/jobs/gaps?sourceId=1&start=1000&end=2000" });
    expect(gaps.statusCode).toBe(200);
    expect(mock.gapCoverage).toHaveBeenCalledWith(1, 1000, 2000);
    const fill = await app.inject({ method: "POST", url: "/api/jobs/fill-gaps", payload: { sourceId: 1, start: 1000, end: 2000, limit: 25 } });
    expect(fill.statusCode).toBe(200);
    expect(mock.fillGaps).toHaveBeenCalledWith(1, 1000, 2000, 25);
    expect((await app.inject({ method: "GET", url: "/api/jobs/gaps?sourceId=1&start=2000&end=1000" })).statusCode).toBe(400);
  });

  it("reads and updates the auto-fill configuration", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    const get = await app.inject({ method: "GET", url: "/api/auto-fill/1" });
    expect(get.statusCode).toBe(200);
    expect(mock.getAutoFill).toHaveBeenCalledWith(1);
    const put = await app.inject({ method: "PUT", url: "/api/auto-fill/1", payload: { enabled: true, batchSize: 100 } });
    expect(put.statusCode).toBe(200);
    expect(mock.updateAutoFill).toHaveBeenCalledWith(1, { enabled: true, batchSize: 100 });
  });

  it("reports process and database health", async () => {
    const app = buildApp(services()); apps.push(app);
    expect((await app.inject({ method: "GET", url: "/api/health/live" })).json()).toEqual({ status: "ok", commit: "development" });
    expect((await app.inject({ method: "GET", url: "/api/health/ready" })).json()).toEqual({ status: "ready", commit: "development" });
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

  it("accepts AO3-scale work IDs and explains the range-size limit", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    const high = await app.inject({
      method: "POST", url: "/api/jobs/id-range",
      payload: { sourceId: 1, start: 90_800_000, end: 90_919_366 },
    });
    expect(high.statusCode).toBe(201);
    expect(mock.createIdRangeJob).toHaveBeenCalledWith(1, { start: 90_800_000, end: 90_919_366, batchSize: 250 });
    const oversized = await app.inject({ method: "POST", url: "/api/jobs/id-range", payload: { sourceId: 1, start: 1, end: 10_000_001 } });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json()).toMatchObject({ error: "validation_error" });
    expect(JSON.stringify(oversized.json())).toContain("10,000,000 IDs");
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
    const packageId = "00000000-0000-4000-8000-000000000003";
    expect((await app.inject({ method: "PATCH", url: `/api/exports/by-package/${packageId}/import-status`, payload: { status: "importing" } })).statusCode).toBe(200);
    expect(mock.updateImportStatusByPackage).toHaveBeenCalledWith(packageId, { status: "importing" });
  });

  it("returns useful request IDs and messages for server errors", async () => {
    const mock = services();
    vi.mocked(mock.pauseJob).mockRejectedValue(new Error("database lock timeout"));
    const app = buildApp(mock); apps.push(app);
    const response = await app.inject({ method: "POST", url: "/api/jobs/7/pause" });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ error: "internal_error" });
    expect(response.json().message).toContain("database lock timeout");
    expect(response.json().requestId).toBeTruthy();
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

  it("deletes terminal jobs and clears cancelled jobs", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    expect((await app.inject({ method: "DELETE", url: "/api/jobs/7" })).statusCode).toBe(200);
    expect(mock.deleteJob).toHaveBeenCalledWith(7);

    vi.mocked(mock.deleteJob).mockResolvedValueOnce("not_found");
    expect((await app.inject({ method: "DELETE", url: "/api/jobs/999" })).statusCode).toBe(404);

    vi.mocked(mock.deleteJob).mockResolvedValueOnce("not_deletable");
    const conflict = await app.inject({ method: "DELETE", url: "/api/jobs/8" });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toMatchObject({ error: "job_not_terminal" });

    expect((await app.inject({ method: "POST", url: "/api/jobs/clear-cancelled" })).statusCode).toBe(200);
    expect(mock.clearCancelledJobs).toHaveBeenCalled();
  });

  it("retries interrupted planning", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    expect((await app.inject({ method: "POST", url: "/api/jobs/7/retry-planning" })).statusCode).toBe(200);
    expect(mock.retryPlanning).toHaveBeenCalledWith(7);

    vi.mocked(mock.retryPlanning).mockResolvedValueOnce("already_completed");
    expect((await app.inject({ method: "POST", url: "/api/jobs/8/retry-planning" })).statusCode).toBe(409);

    vi.mocked(mock.retryPlanning).mockResolvedValueOnce("not_found");
    expect((await app.inject({ method: "POST", url: "/api/jobs/999/retry-planning" })).statusCode).toBe(404);
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

  it("accepts operator-selected source limits including zero/unlimited values", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    const unrestricted = await app.inject({
      method: "PUT", url: "/api/sources/1",
      payload: {
        ...policy,
        minimumDelayMs: 0,
        dailyRequestBudget: 0,
        dailyByteBudget: 0,
        requestTimeoutMs: 0,
        maximumResponseBytes: 0,
        maximumFailureAttempts: 0,
        paused: false,
      },
    });
    expect(unrestricted.statusCode).toBe(200);
    const negative = await app.inject({
      method: "PUT", url: "/api/sources/1",
      payload: { ...policy, minimumDelayMs: -1, paused: true },
    });
    expect(negative.statusCode).toBe(400);
    expect(negative.json()).toMatchObject({
      error: "validation_error",
      issues: [{ path: ["minimumDelayMs"] }],
    });
  });
});
