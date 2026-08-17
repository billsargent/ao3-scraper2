import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ParseError, parseEntireWorkHtml } from "../src/index.js";

const fixtureUrl = new URL("./fixtures/work-entire.html", import.meta.url);

describe("AO3 entire-work parser", () => {
  it("extracts a complete normalized work without network access", async () => {
    const html = await readFile(fileURLToPath(fixtureUrl), "utf8");
    const records = parseEntireWorkHtml(html, {
      sourceUrl: "https://archiveofourown.org/works/12345?view_full_work=true",
      capturedAt: "2026-08-17T12:00:00.000Z",
    });

    expect(records.works[0]).toMatchObject({
      sourceWorkId: "12345",
      title: "Example Work",
      complete: true,
      expectedChapters: 2,
      words: 18,
      publishedAt: "2021-04-20",
      updatedAt: "2026-08-17",
    });
    expect(records.authors).toEqual([{
      sourceAuthorId: "user:ExampleAuthor",
      name: "ExampleAuthor",
      profileUrl: "https://archiveofourown.org/users/ExampleAuthor/pseuds/ExampleAuthor",
      anonymous: false,
      orphaned: false,
    }]);
    expect(records.chapters.map((chapter) => [chapter.sourceChapterId, chapter.position, chapter.title])).toEqual([
      ["23456", 1, "Chapter One"],
      ["34567", 2, "Chapter Two"],
    ]);
    expect(records.chapters[0]!.contentHtml).toBe("<p>First chapter content.</p>");
    expect(records.tags.map((tag) => [tag.type, tag.name])).toContainEqual(["Fandom", "Example Fandom"]);
    expect(records.tags.map((tag) => [tag.type, tag.name])).toContainEqual(["Freeform", "Friendship"]);
    expect(records.series).toMatchObject([{ sourceSeriesId: "series:100", name: "Example Series" }]);
    expect(records.seriesWorks).toEqual([{ sourceSeriesId: "series:100", sourceWorkId: "12345", position: 1 }]);
    expect(records.observations[0]!.contentHash).toBe(records.works[0]!.contentHash);
  });

  it("fails closed when an entire-work page has no chapter content", () => {
    expect(() => parseEntireWorkHtml("<h2 class='title heading'>Broken</h2>", {
      sourceUrl: "https://archiveofourown.org/works/999",
      capturedAt: "2026-08-17T12:00:00.000Z",
    })).toThrow(ParseError);
  });
});
