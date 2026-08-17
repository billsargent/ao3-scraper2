import { expect, test, type Page, type Route } from "@playwright/test";

const source = {
  id: 1, key: "ao3", origin: "https://archiveofourown.org",
  userAgent: "Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36", includeAdult: true,
  minimumDelayMs: 10000, dailyRequestBudget: 250, dailyByteBudget: 1073741824,
  requestTimeoutMs: 60000, maximumResponseBytes: 20971520, maximumFailureAttempts: 6,
  operatingWindowStartHourUtc: null, operatingWindowEndHourUtc: null,
  paused: true, nextRequestAt: null,
};
const exportRecord = {
  id: 1, sourceId: 1, packageId: "00000000-0000-4000-8000-000000000001",
  previousPackageId: null, sequenceNumber: 1, status: "completed", outputDirectory: "/data/exports/package-1",
  maximumWorks: 500, workCount: 18, errorMessage: null,
  archivePath: "/data/exports/package-1.tar.gz", archiveHash: `sha256:${"a".repeat(64)}`, archiveBytes: 4096,
  verifiedAt: "2026-08-17T12:00:00.000Z", importStatus: "not_imported",
  importStartedAt: null, importedAt: null, importError: null, otwImportRunId: null,
  createdAt: "2026-08-17T12:00:00.000Z", completedAt: "2026-08-17T12:00:01.000Z",
};
const works = Array.from({ length: 18 }, (_value, index) => ({
  id: index + 1,
  sourceWorkId: String(10000 + index),
  title: index === 0 ? "Harry Potter meets Harry Potter" : `Preserved work ${index + 1}`,
  languageCode: "en", complete: true, expectedChapters: index % 3 + 1,
  words: 1000 + index * 250, availability: "public",
  sourceUpdatedAt: "2026-08-17", lastSeenAt: "2026-08-17T12:00:00.000Z",
}));

async function mockApi(page: Page, requireToken = false) {
  let jobCreated = false;
  await page.route("**/api/**", async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (requireToken && url.pathname !== "/api/health/live" && request.headers().authorization !== "Bearer test-token-that-is-definitely-longer-than-32") {
      return route.fulfill({ status: 401, contentType: "application/json", body: '{"error":"unauthorized"}' });
    }
    const json = (value: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(value) });
    if (url.pathname === "/api/health/live") return json({ status: "ok" });
    if (url.pathname === "/api/health/ready") return json({ status: "ready" });
    if (url.pathname === "/api/events") return route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: jobs\ndata: {"jobs":[]}\n\nevent: exports\ndata: ${JSON.stringify({ exports: [exportRecord], total: 1 })}\n\n` });
    if (url.pathname === "/api/sources" && request.method() === "GET") return json({ sources: [source] });
    if (url.pathname.startsWith("/api/sources/") && request.method() === "PUT") return json({ updated: true });
    if (url.pathname === "/api/jobs/id-range" && request.method() === "POST") { jobCreated = true; return json({ jobId: 42 }, 201); }
    if (url.pathname.match(/^\/api\/jobs\/42\/(pause|resume|cancel)$/)) return json({ updated: true });
    if (url.pathname === "/api/jobs") return json({ jobs: jobCreated ? [{ id: 42, sourceId: 1, type: "id_range", status: "queued", configuration: { start: 100, end: 105, batchSize: 250 }, planningStatus: "completed", planningCursor: 106, planningError: null, discoveredCount: 6, succeededCount: 0, failedCount: 0, skippedCount: 0, createdAt: "2026-08-17T12:00:00.000Z", startedAt: null, completedAt: null }] : [], limit: 100, offset: 0 });
    if (url.pathname === "/api/failures") return json({ failures: [], total: 0 });
    if (url.pathname === "/api/exports") return request.method() === "POST" ? json({ id: 1, packageId: exportRecord.packageId }, 202) : json({ exports: [exportRecord], total: 1 });
    if (url.pathname === "/api/exports/1") return json({ export: exportRecord });
    if (url.pathname === "/api/exports/1/manifest") return json({ manifest: { packageId: exportRecord.packageId, packageType: "snapshot", createdAt: exportRecord.createdAt, records: { works: 18, chapters: 79, tags: 203 } }, checksums: "abc  works.jsonl\n", archiveHash: exportRecord.archiveHash, archiveBytes: exportRecord.archiveBytes, verifiedAt: exportRecord.verifiedAt });
    if (url.pathname === "/api/exports/1/import-status") return json({ updated: true });
    if (url.pathname === "/api/exports/1/download") return route.fulfill({ status: 200, contentType: "application/gzip", headers: { "content-disposition": 'attachment; filename="package-1.tar.gz"', "x-content-sha256": exportRecord.archiveHash }, body: "fake-gzip" });
    if (url.pathname === "/api/works") {
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? 10);
      const query = (url.searchParams.get("q") ?? "").toLowerCase();
      const filtered = works.filter((work) => work.title.toLowerCase().includes(query) || work.sourceWorkId.includes(query));
      return json({ works: filtered.slice(offset, offset + limit), total: filtered.length, limit, offset });
    }
    if (url.pathname === "/api/works/1") return json({ work: {
      ...works[0], sourceUrl: "https://archiveofourown.org/works/10000",
      summaryHtml: "<p>A preserved summary.</p>", notesHtml: "", endNotesHtml: "", contentHash: "sha256:test",
      chapters: [{ id: 11, sourceChapterId: "chapter-11", position: 1, title: "The first chapter", wordCount: 1000, contentHash: "sha256:chapter" }],
    } });
    if (url.pathname === "/api/works/1/chapters/11") return json({ chapter: {
      id: 11, sourceChapterId: "chapter-11", position: 1, title: "The first chapter", wordCount: 1000,
      contentHash: "sha256:chapter", summaryHtml: "", notesHtml: "<p>Beginning note.</p>",
      contentHtml: "<p>This chapter is readable completely offline.</p><p>Second paragraph.</p>", endNotesHtml: "<p>End note.</p>", publishedAt: "2026-08-17",
    } });
    return json({ error: "not_found" }, 404);
  });
}

test("library is a paginated list and opens the offline reader", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Archive library" }).click();
  await expect(page.getByRole("heading", { name: "18 collected works" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "Harry Potter meets Harry Potter Complete · EN" })).toBeVisible();
  await expect(page.getByText("Page 1 of 2")).toBeVisible();
  await page.getByRole("button", { name: "View", exact: true }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Harry Potter meets Harry Potter" })).toBeVisible();
  await expect(page.getByText("This chapter is readable completely offline.")).toBeVisible();
  await expect(page.getByText("End note.")).toBeVisible();
  await page.getByRole("button", { name: "Close reader" }).click();
  await page.getByRole("button", { name: "Next →", exact: true }).click();
  await expect(page.getByText("Page 2 of 2")).toBeVisible();
  await page.getByRole("button", { name: "← Previous", exact: true }).click();
  await expect(page.getByText("Page 1 of 2")).toBeVisible();
});

test("operator creates and controls a durable range job", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Collection jobs" }).click();
  await page.getByRole("button", { name: "New job" }).click();
  await page.getByLabel("Starting work ID").fill("100");
  await page.getByLabel("Ending work ID").fill("105");
  await page.getByRole("button", { name: "Create durable job" }).click();
  await expect(page.getByText("#42")).toBeVisible();
  await expect(page.getByText("100–105")).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
});

test("source settings expose Browser ID and granular policy", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Source settings" }).click();
  await expect(page.getByLabel("Browser ID / User-Agent")).toHaveValue(source.userAgent);
  await expect(page.getByLabel("Daily bandwidth (MB)")).toHaveValue("1024");
  await expect(page.getByLabel("Maximum response (MB)")).toHaveValue("20");
  await expect(page.getByLabel("Request timeout (seconds)")).toHaveValue("60");
  await expect(page.getByText("Collection paused")).toBeVisible();
});

test("transfer package inspector verifies, downloads, and tracks OTW import", async ({ page }) => {
  await mockApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Transfer packages" }).click();
  await expect(page.getByText("Sequence 1 · Export #1")).toBeVisible();
  await page.getByRole("button", { name: "Inspect" }).click();
  await expect(page.getByRole("dialog", { name: "Export details" })).toBeVisible();
  await expect(page.getByText("Manifest contents")).toBeVisible();
  await expect(page.getByText(exportRecord.archiveHash)).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download .tar.gz" }).click();
  expect((await downloadPromise).suggestedFilename()).toBe("package-1.tar.gz");
  await page.getByRole("button", { name: "Mark imported" }).click();
});

test("operator token unlock retries authenticated API calls", async ({ page }) => {
  await mockApi(page, true);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Unlock operator access" })).toBeVisible();
  await page.getByLabel("API token").fill("test-token-that-is-definitely-longer-than-32");
  await page.getByRole("button", { name: "Unlock archive" }).click();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
});
