import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { SourceRequestError } from "@ao3-offsite/scraper-core";
import { WorkTaskProcessor } from "../src/processor.js";

const fixtureUrl = new URL("../../scraper-core/test/fixtures/work-entire.html", import.meta.url);

function dependencies() {
  const fetcher = { fetchText: vi.fn() };
  const blobs = { putHtml: vi.fn().mockResolvedValue({
    bodyHash: `sha256:${"a".repeat(64)}`,
    storageKey: "sha256/aa/aa/file.html.gz",
    byteLength: 100,
    compressedByteLength: 50,
  }) };
  const store = {
    recordSnapshot: vi.fn().mockResolvedValue(undefined),
    persistCapturedWork: vi.fn().mockResolvedValue(42),
    persistAvailability: vi.fn().mockResolvedValue(undefined),
  };
  return { fetcher, blobs, store };
}

describe("WorkTaskProcessor", () => {
  it("snapshots, parses, and persists an entire work", async () => {
    const html = await readFile(fileURLToPath(fixtureUrl), "utf8");
    const { fetcher, blobs, store } = dependencies();
    fetcher.fetchText.mockImplementation(async (url: URL) => ({
      url: url.toString(), status: 200, body: html, fetchedAt: "2026-08-17T12:00:00.000Z",
      attempts: 1, responseHeaders: { "content-type": "text/html" },
    }));
    const processor = new WorkTaskProcessor(
      { id: 1, origin: "https://archiveofourown.org", includeAdult: true },
      fetcher, blobs, store,
    );

    const outcome = await processor.process("12345");
    expect(outcome).toMatchObject({ status: "succeeded", localWorkId: 42 });
    const requested = fetcher.fetchText.mock.calls[0]![0] as URL;
    expect(requested.pathname).toBe("/works/12345");
    expect(requested.searchParams.get("view_full_work")).toBe("true");
    expect(requested.searchParams.get("view_adult")).toBe("true");
    expect(store.recordSnapshot).toHaveBeenCalledBefore(store.persistCapturedWork);
    expect(store.persistCapturedWork.mock.calls[0]![1].chapters).toHaveLength(2);
  });

  it("records a not-found observation without parsing", async () => {
    const { fetcher, blobs, store } = dependencies();
    fetcher.fetchText.mockRejectedValue(new SourceRequestError("not found", false, 404));
    const processor = new WorkTaskProcessor(
      { id: 1, origin: "https://archiveofourown.org", includeAdult: false },
      fetcher, blobs, store,
    );

    await expect(processor.process("999")).resolves.toEqual({
      status: "not_found", code: "http_404", message: "not found", responseBytes: 0,
    });
    expect(store.persistAvailability).toHaveBeenCalledWith(1, expect.objectContaining({ availability: "not_found", httpStatus: 404 }));
    expect(blobs.putHtml).not.toHaveBeenCalled();
  });

  it("retains the raw snapshot when parsing fails", async () => {
    const { fetcher, blobs, store } = dependencies();
    fetcher.fetchText.mockResolvedValue({
      url: "https://archiveofourown.org/works/1?view_full_work=true", status: 200,
      body: "<html>unexpected shape</html>", fetchedAt: "2026-08-17T12:00:00.000Z", attempts: 1, responseHeaders: {},
    });
    const processor = new WorkTaskProcessor(
      { id: 1, origin: "https://archiveofourown.org", includeAdult: false },
      fetcher, blobs, store,
    );

    await expect(processor.process("1")).resolves.toMatchObject({ status: "terminal_failed", code: "parse_failed" });
    expect(store.recordSnapshot).toHaveBeenCalledOnce();
    expect(store.persistCapturedWork).not.toHaveBeenCalled();
  });
});
