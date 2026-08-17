export * from "./source-client.js";

import { createHash } from "node:crypto";
import { load, type CheerioAPI } from "cheerio";
import type {
  Author,
  Chapter,
  Observation,
  Series,
  SeriesWork,
  Tag,
  TransferRecords,
  Work,
  WorkAuthor,
  WorkTag,
} from "@ao3-offsite/contracts";

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

type TagType = Tag["type"];

const tagSelectors: Array<[TagType, string]> = [
  ["Rating", "dd.rating.tags a.tag"],
  ["ArchiveWarning", "dd.warning.tags a.tag"],
  ["Category", "dd.category.tags a.tag"],
  ["Fandom", "dd.fandom.tags a.tag"],
  ["Relationship", "dd.relationship.tags a.tag"],
  ["Character", "dd.character.tags a.tag"],
  ["Freeform", "dd.freeform.tags a.tag"],
];

const languageCodes: Record<string, string> = {
  English: "en",
  Svenska: "sv",
  Español: "es",
  Français: "fr",
  Deutsch: "de",
  Italiano: "it",
  Português: "ptBR",
  日本語: "ja",
  中文: "zh",
};

function hash(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function compactText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function innerHtml($: CheerioAPI, selector: string): string {
  return $(selector).first().html()?.trim() ?? "";
}

function integer(text: string): number | null {
  const normalized = text.replace(/,/g, "").trim();
  if (!/^\d+$/.test(normalized)) return null;
  return Number.parseInt(normalized, 10);
}

function sourceIdFromHref(href: string | undefined, fallback: string): string {
  if (!href) return fallback;
  const match = href.match(/^\/users\/([^/]+)/) ?? href.match(/^\/series\/(\d+)/) ?? href.match(/^\/tags\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : href;
}

function workIdFromUrl(sourceUrl: string): string {
  const match = new URL(sourceUrl).pathname.match(/^\/works\/(\d+)/);
  if (!match?.[1]) throw new ParseError(`Cannot identify work ID from ${sourceUrl}`);
  return match[1];
}

function parseAuthors($: CheerioAPI, sourceWorkId: string, origin: string): { authors: Author[]; relations: WorkAuthor[] } {
  const links = $("#workskin > .preface h3.byline a[rel='author'], #workskin h3.byline a[rel='author']").toArray();
  if (links.length === 0) {
    const byline = compactText($("#workskin h3.byline").first().text());
    const anonymous = /anonymous/i.test(byline);
    const sourceAuthorId = anonymous ? "anonymous" : `byline:${byline || "unknown"}`;
    return {
      authors: [{ sourceAuthorId, name: byline || "Anonymous", profileUrl: null, anonymous, orphaned: /orphan_account/i.test(byline) }],
      relations: [{ sourceWorkId, sourceAuthorId, position: 1 }],
    };
  }

  const authors = links.map((element) => {
    const node = $(element);
    const name = compactText(node.text());
    const href = node.attr("href");
    return {
      sourceAuthorId: `user:${sourceIdFromHref(href, name)}`,
      name,
      profileUrl: href ? new URL(href, origin).toString() : null,
      anonymous: false,
      orphaned: /orphan_account/.test(href ?? ""),
    } satisfies Author;
  });
  return {
    authors,
    relations: authors.map((author, index) => ({ sourceWorkId, sourceAuthorId: author.sourceAuthorId, position: index + 1 })),
  };
}

function parseTags($: CheerioAPI, sourceWorkId: string, origin: string): { tags: Tag[]; relations: WorkTag[] } {
  const tags: Tag[] = [];
  const relations: WorkTag[] = [];
  let position = 0;
  for (const [type, selector] of tagSelectors) {
    $(selector).each((_index, element) => {
      const node = $(element);
      const name = compactText(node.text());
      const href = node.attr("href");
      const sourceTagId = `tag:${type}:${sourceIdFromHref(href, name)}`;
      if (!tags.some((tag) => tag.sourceTagId === sourceTagId)) {
        tags.push({ sourceTagId, type, name, canonical: null, sourceUrl: href ? new URL(href, origin).toString() : null });
      }
      relations.push({ sourceWorkId, sourceTagId, position: position++ });
    });
  }
  return { tags, relations };
}

function parseChapters($: CheerioAPI, sourceWorkId: string): Chapter[] {
  const chapters: Chapter[] = [];
  $("#chapters > .chapter").each((index, element) => {
    const chapter = $(element);
    const href = chapter.find(".chapter.preface h3.title a[href*='/chapters/']").first().attr("href");
    const hrefId = href?.match(/\/chapters\/(\d+)/)?.[1];
    const elementId = chapter.attr("id")?.match(/chapter[_-](\d+)/)?.[1];
    const contentHtml = chapter.find(".userstuff.module[role='article']").first().html()?.trim() ?? "";
    if (!contentHtml) throw new ParseError(`Chapter ${index + 1} of work ${sourceWorkId} has no content`);
    chapters.push({
      sourceWorkId,
      sourceChapterId: hrefId ?? elementId ?? `position:${index + 1}`,
      position: index + 1,
      title: compactText(chapter.find(".chapter.preface h3.title").first().text()),
      summaryHtml: chapter.find(".chapter.preface .summary blockquote.userstuff").first().html()?.trim() ?? "",
      notesHtml: chapter.find(".chapter.preface .notes blockquote.userstuff").first().html()?.trim() ?? "",
      contentHtml,
      endNotesHtml: chapter.find(".chapter.end.notes blockquote.userstuff").first().html()?.trim() ?? "",
      publishedAt: null,
      wordCount: null,
      contentHash: hash(contentHtml),
    });
  });
  if (chapters.length === 0) throw new ParseError(`Work ${sourceWorkId} contains no entire-work chapters`);
  return chapters;
}

function parseSeries($: CheerioAPI, sourceWorkId: string, origin: string): { series: Series[]; relations: SeriesWork[] } {
  const series: Series[] = [];
  const relations: SeriesWork[] = [];
  $("#workskin .series .position").each((_index, element) => {
    const positionNode = $(element);
    const link = positionNode.find("a[href*='/series/']").first();
    const href = link.attr("href");
    if (!href) return;
    const sourceSeriesId = `series:${sourceIdFromHref(href, compactText(link.text()))}`;
    const position = Number.parseInt(positionNode.text().match(/Part\s+(\d+)/i)?.[1] ?? "1", 10);
    series.push({
      sourceSeriesId,
      name: compactText(link.text()),
      sourceUrl: new URL(href, origin).toString(),
      summaryHtml: "",
      complete: null,
    });
    relations.push({ sourceSeriesId, sourceWorkId, position });
  });
  return { series, relations };
}

export interface ParseWorkOptions {
  sourceUrl: string;
  capturedAt: string;
}

export function parseEntireWorkHtml(html: string, options: ParseWorkOptions): TransferRecords {
  const sourceUrl = new URL(options.sourceUrl);
  const sourceWorkId = workIdFromUrl(options.sourceUrl);
  const $ = load(html);
  const title = compactText($("#workskin h2.title.heading").first().text());
  if (!title) throw new ParseError(`Work ${sourceWorkId} has no title`);

  const chapters = parseChapters($, sourceWorkId);
  const parsedAuthors = parseAuthors($, sourceWorkId, sourceUrl.origin);
  const parsedTags = parseTags($, sourceWorkId, sourceUrl.origin);
  const parsedSeries = parseSeries($, sourceWorkId, sourceUrl.origin);
  const chapterStat = compactText($("dl.stats dd.chapters").first().text());
  const [currentText, expectedText] = chapterStat.split("/");
  const currentChapters = integer(currentText ?? "");
  const expectedChapters = expectedText === "?" ? null : integer(expectedText ?? "");
  const complete = expectedChapters !== null && currentChapters === expectedChapters;
  const updatedAt = compactText($("dl.stats dd.status").first().text()) || compactText($("dl.stats dd.published").first().text()) || null;
  const languageName = compactText($("dl.work.meta dd.language").first().text());

  const workWithoutHash = {
    operation: "upsert" as const,
    sourceWorkId,
    sourceUrl: options.sourceUrl,
    title,
    summaryHtml: innerHtml($, "#workskin > .preface .summary blockquote.userstuff"),
    languageCode: languageCodes[languageName] ?? "en",
    publishedAt: compactText($("dl.stats dd.published").first().text()) || null,
    updatedAt,
    complete,
    restricted: false,
    expectedChapters,
    words: integer($("dl.stats dd.words").first().text()),
    notesHtml: innerHtml($, "#workskin > .preface .notes blockquote.userstuff"),
    endNotesHtml: innerHtml($, "#workskin > .afterword .end.notes blockquote.userstuff"),
  };
  const work: Work = {
    ...workWithoutHash,
    contentHash: hash(JSON.stringify({ work: workWithoutHash, chapters: chapters.map((chapter) => chapter.contentHash), tags: parsedTags.relations })),
  };
  const observation: Observation = {
    sourceWorkId,
    observedAt: options.capturedAt,
    availability: "public",
    httpStatus: 200,
    sourceUpdatedAt: updatedAt,
    contentHash: work.contentHash,
  };

  return {
    authors: parsedAuthors.authors,
    workAuthors: parsedAuthors.relations,
    works: [work],
    chapters,
    tags: parsedTags.tags,
    workTags: parsedTags.relations,
    series: parsedSeries.series,
    seriesWorks: parsedSeries.relations,
    observations: [observation],
  };
}
