import { describe, expect, it, vi } from "vitest";
import { PoliteSourceClient, SourceRequestError } from "../src/source-client.js";

function response(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

describe("PoliteSourceClient", () => {
  it("rejects cross-origin requests before fetching", async () => {
    const fetchMock = vi.fn();
    const client = new PoliteSourceClient({
      origin: "https://archiveofourown.org",
      userAgent: "OfflineArchiveBot/0.1 contact@example.invalid",
      fetch: fetchMock,
    });
    await expect(client.fetchText("https://example.com/work/1")).rejects.toBeInstanceOf(SourceRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors Retry-After and retries a 429 response", async () => {
    let time = 0;
    const sleeps: number[] = [];
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response("slow down", 429, { "retry-after": "10" }))
      .mockResolvedValueOnce(response("<html>ok</html>"));
    const client = new PoliteSourceClient({
      origin: "https://archiveofourown.org",
      userAgent: "OfflineArchiveBot/0.1 contact@example.invalid",
      minimumDelayMs: 5_000,
      fetch: fetchMock,
      now: () => time,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); time += milliseconds; },
    });

    const result = await client.fetchText("/works/123");
    expect(result.body).toBe("<html>ok</html>");
    expect(result.attempts).toBe(2);
    expect(sleeps).toEqual([10_000]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("serializes callers and spaces request starts", async () => {
    let time = 0;
    const sleeps: number[] = [];
    const fetchMock = vi.fn().mockImplementation(async () => response("ok"));
    const client = new PoliteSourceClient({
      origin: "https://archiveofourown.org",
      userAgent: "OfflineArchiveBot/0.1 contact@example.invalid",
      minimumDelayMs: 2_000,
      fetch: fetchMock,
      now: () => time,
      sleep: async (milliseconds) => { sleeps.push(milliseconds); time += milliseconds; },
    });

    await Promise.all([client.fetchText("/works/1"), client.fetchText("/works/2")]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleeps).toEqual([2_000]);
  });

  it("rejects oversized bodies", async () => {
    const client = new PoliteSourceClient({
      origin: "https://archiveofourown.org",
      userAgent: "OfflineArchiveBot/0.1 contact@example.invalid",
      maximumBodyBytes: 4,
      fetch: async () => response("too large"),
    });
    await expect(client.fetchText("/works/1")).rejects.toThrow("Response exceeds body limit");
  });

  it("enforces a conservative delay floor", () => {
    expect(() => new PoliteSourceClient({
      origin: "https://archiveofourown.org",
      userAgent: "OfflineArchiveBot/0.1 contact@example.invalid",
      minimumDelayMs: 500,
    })).toThrow("cannot be lower than 2000ms");
  });
});
