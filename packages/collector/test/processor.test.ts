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

  it("captures social metadata and merges it into the transfer records", async () => {
    const html = await readFile(fileURLToPath(fixtureUrl), "utf8");
    const { fetcher, blobs, store } = dependencies();
    fetcher.fetchText.mockImplementation(async (url: URL | string) => {
      const parsed = new URL(url.toString());
      const commentPage = (id: string) => `<ol class="thread"><li class="comment group" id="comment_${id}">
        <h4 class="heading byline"><a href="/users/SomeUser/pseuds/SomeUser">SomeUser</a>
        <span class="posted datetime"><abbr class="day" title="Sat">Sat</abbr> <span class="date">15</span> <abbr class="month" title="Nov">Nov</abbr> <span class="year">2025</span> <span class="time">12:16AM</span> <abbr class="timezone" title="UTC">UTC</abbr></span></h4>
        <blockquote class="userstuff"><p>Comment ${id}</p></blockquote><ul class="actions"><li><a href="/comments/${id}">Thread</a></li></ul></li></ol>`;
      const pathname = parsed.pathname;
      if (pathname === "/works/12345") return { url: parsed.toString(), status: 200, body: html, fetchedAt: "2026-08-17T12:00:00.000Z", attempts: 1, responseHeaders: {} };
      if (pathname.includes("/chapters/")) {
        const id = pathname.split("/chapters/")[1];
        return { url: parsed.toString(), status: 200, body: commentPage(`chapter-${id}`), fetchedAt: "2026-08-17T12:00:01.000Z", attempts: 1, responseHeaders: {} };
      }
      if (pathname.endsWith("/kudos")) {
        return { url: parsed.toString(), status: 200, body: `<div id="kudos"><a href="/users/A">A</a>, <a href="/users/B">B</a> left kudos!</div>`, fetchedAt: "2026-08-17T12:00:02.000Z", attempts: 1, responseHeaders: {} };
      }
      if (pathname.endsWith("/bookmarks")) {
        return { url: parsed.toString(), status: 200, body: `<ol class="bookmark index group"><li class="user short blurb group"><div class="header module"><h5 class="byline heading">Bookmarked by <a href="/users/Bob/pseuds/Bob">Bob</a></h5><p class="datetime">01 Aug 2026</p></div><blockquote class="userstuff"><p>Good.</p></blockquote></li></ol>`, fetchedAt: "2026-08-17T12:00:03.000Z", attempts: 1, responseHeaders: {} };
      }
      return { url: parsed.toString(), status: 200, body: "<html></html>", fetchedAt: "2026-08-17T12:00:04.000Z", attempts: 1, responseHeaders: {} };
    });
    const processor = new WorkTaskProcessor(
      {
        id: 1, origin: "https://archiveofourown.org", includeAdult: true,
        captureComments: true, captureKudos: true, captureBookmarks: true,
      },
      fetcher, blobs, store,
    );

    const outcome = await processor.process("12345");
    expect(outcome.status).toBe("succeeded");
    const persisted = store.persistCapturedWork.mock.calls[0]![1];
    expect(persisted.comments.map((comment) => comment.sourceCommentId)).toEqual(["chapter-23456", "chapter-34567"]);
    expect(persisted.kudos.map((kudo) => kudo.sourceKudoId)).toEqual(["user:A", "user:B"]);
    expect(persisted.bookmarks).toEqual([expect.objectContaining({ sourceBookmarkId: "bookmark:12345:Bob" })]);
  });

  it("stops social pagination when a listing page links back to itself", async () => {
    const html = await readFile(fileURLToPath(fixtureUrl), "utf8");
    const { fetcher, blobs, store } = dependencies();
    fetcher.fetchText.mockImplementation(async (url: URL | string) => {
      const parsed = new URL(url.toString());
      if (parsed.pathname === "/works/12345") {
        return { url: parsed.toString(), status: 200, body: html, fetchedAt: "2026-08-17T12:00:00.000Z", attempts: 1, responseHeaders: {} };
      }
      if (parsed.pathname.endsWith("/kudos")) {
        return {
          url: parsed.toString(), status: 200, fetchedAt: "2026-08-17T12:00:01.000Z", attempts: 1, responseHeaders: {},
          body: `<div id="kudos"><a href="/users/A">A</a> left kudos!</div><ol class="pagination"><li class="next"><a rel="next" href="/works/12345/kudos">Next →</a></li></ol>`,
        };
      }
      return { url: parsed.toString(), status: 200, body: "<html></html>", fetchedAt: "2026-08-17T12:00:02.000Z", attempts: 1, responseHeaders: {} };
    });
    const processor = new WorkTaskProcessor(
      { id: 1, origin: "https://archiveofourown.org", includeAdult: true, captureKudos: true },
      fetcher, blobs, store,
    );

    await expect(processor.process("12345")).resolves.toMatchObject({ status: "succeeded" });
    const kudosFetches = fetcher.fetchText.mock.calls.filter(([input]) => new URL(input.toString()).pathname.endsWith("/kudos"));
    expect(kudosFetches).toHaveLength(1);
  });
});
