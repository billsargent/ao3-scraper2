import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../src/app.js";
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
    listWorks: vi.fn().mockResolvedValue([]),
    getWork: vi.fn().mockResolvedValue(null),
  };
}

const apps: ReturnType<typeof buildApp>[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

describe("Fastify control API", () => {
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
    const huge = await app.inject({ method: "POST", url: "/api/jobs/id-range", payload: { sourceId: 1, start: 1, end: 10002 } });
    expect(huge.statusCode).toBe(400);
  });

  it("controls jobs and returns not found records", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    expect((await app.inject({ method: "POST", url: "/api/jobs/7/pause" })).statusCode).toBe(200);
    expect(mock.pauseJob).toHaveBeenCalledWith(7);
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
    expect(mock.createSource).toHaveBeenCalledWith({
      key: "ao3", origin: "https://archiveofourown.org", minimumDelayMs: 10000, dailyRequestBudget: 250,
    });
  });

  it("validates conservative source settings", async () => {
    const mock = services(); const app = buildApp(mock); apps.push(app);
    const tooFast = await app.inject({
      method: "PUT", url: "/api/sources/1",
      payload: { minimumDelayMs: 500, dailyRequestBudget: 250, paused: false },
    });
    expect(tooFast.statusCode).toBe(400);
    const valid = await app.inject({
      method: "PUT", url: "/api/sources/1",
      payload: { minimumDelayMs: 10000, dailyRequestBudget: 250, paused: true },
    });
    expect(valid.statusCode).toBe(200);
  });
});
