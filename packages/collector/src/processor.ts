import type { Comment, Kudo, Observation, TransferRecords } from "@ao3-offsite/contracts";
import {
  ParseError,
  SourceRequestError,
  nextPageUrl,
  parseBookmarksHtml,
  parseCommentsHtml,
  parseEntireWorkHtml,
  parseKudosHtml,
  type FetchResult,
} from "@ao3-offsite/scraper-core";
import type { StoredBlob } from "./blob-store.js";

export const PARSER_VERSION = "ao3-entire-work-v1";

export interface SourceFetcher {
  fetchText(input: string | URL): Promise<FetchResult>;
}

export interface RawBlobStore {
  putHtml(body: string): Promise<StoredBlob>;
}

export interface CapturedWorkStore {
  recordSnapshot(input: {
    sourceId: number;
    sourceWorkId: string;
    url: string;
    httpStatus: number;
    fetchedAt: Date;
    bodyHash?: string | null;
    storageKey?: string | null;
    responseHeaders?: Record<string, string>;
    parserVersion?: string | null;
    attempts?: number;
  }): Promise<void>;
  persistCapturedWork(sourceId: number, records: TransferRecords): Promise<number>;
  persistAvailability(sourceId: number, observation: Observation): Promise<void>;
}

export interface RequestGate {
  reserve(): Promise<{ granted: boolean; retryAt: Date | null }>;
}

export interface ProcessorSource {
  id: number;
  origin: string;
  includeAdult: boolean;
  captureComments?: boolean;
  captureKudos?: boolean;
  captureBookmarks?: boolean;
  maximumCommentPages?: number | null;
  maximumKudosPages?: number | null;
  maximumBookmarkPages?: number | null;
}

export type TaskOutcome =
  | { status: "succeeded"; localWorkId: number; contentHash: string; responseBytes: number }
  | { status: "not_found"; code: string; message: string; responseBytes: number }
  | { status: "retryable_failed"; code: string; message: string; responseBytes: number }
  | { status: "terminal_failed"; code: string; message: string; responseBytes: number };

export class WorkTaskProcessor {
  constructor(
    private readonly source: ProcessorSource,
    private readonly fetcher: SourceFetcher,
    private readonly blobs: RawBlobStore,
    private readonly store: CapturedWorkStore,
    private readonly gate?: RequestGate,
  ) {}

  async process(sourceWorkId: string): Promise<TaskOutcome> {
    if (!/^\d+$/.test(sourceWorkId)) return { status: "terminal_failed", code: "invalid_work_id", message: "Work ID must be numeric", responseBytes: 0 };
    let responseBytes = 0;
    const url = new URL(`/works/${sourceWorkId}`, this.source.origin);
    url.searchParams.set("view_full_work", "true");
    if (this.source.includeAdult) url.searchParams.set("view_adult", "true");
    if (this.source.captureComments) url.searchParams.set("show_comments", "true");

    try {
      const fetched = await this.fetcher.fetchText(url);
      responseBytes = Buffer.byteLength(fetched.body, "utf8");
      const blob = await this.blobs.putHtml(fetched.body);
      await this.store.recordSnapshot({
        sourceId: this.source.id,
        sourceWorkId,
        url: fetched.url,
        httpStatus: fetched.status,
        fetchedAt: new Date(fetched.fetchedAt),
        bodyHash: blob.bodyHash,
        storageKey: blob.storageKey,
        responseHeaders: fetched.responseHeaders,
        parserVersion: PARSER_VERSION,
        attempts: fetched.attempts,
      });
      const records = parseEntireWorkHtml(fetched.body, { sourceUrl: fetched.url, capturedAt: fetched.fetchedAt });
      responseBytes += await this.captureSocial(sourceWorkId, fetched.body, records, fetched.fetchedAt);
      const localWorkId = await this.store.persistCapturedWork(this.source.id, records);
      return { status: "succeeded", localWorkId, contentHash: records.works[0]!.contentHash, responseBytes };
    } catch (error) {
      if (error instanceof SourceRequestError) return this.sourceFailure(sourceWorkId, url, error);
      if (error instanceof ParseError) return { status: "terminal_failed", code: "parse_failed", message: error.message, responseBytes };
      return { status: "retryable_failed", code: "unexpected", message: error instanceof Error ? error.message : String(error), responseBytes };
    }
  }

  /**
   * Capture comments, kudos, and bookmarks for a work, appending them to `records`.
   * Returns the number of response bytes consumed by the extra fetches.
   */
  private async captureSocial(sourceWorkId: string, workPageBody: string, records: TransferRecords, capturedAt: string): Promise<number> {
    const settings = this.source;
    if (!settings.captureComments && !settings.captureKudos && !settings.captureBookmarks) return 0;
    const maximumCommentPages = settings.maximumCommentPages ?? null;
    const maximumKudosPages = settings.maximumKudosPages ?? null;
    const maximumBookmarkPages = settings.maximumBookmarkPages ?? null;

    const creatorProfileUrls = records.authors
      .map((author) => author.profileUrl)
      .filter((url): url is string => url !== null);

    const comments = new Map<string, Comment>();
    const kudos = new Map<string, Kudo>();
    const bookmarks = new Map<string, ReturnType<typeof parseBookmarksHtml>[number]>();
    let responseBytes = 0;
    let commentPages = 0;

    const addComments = (list: Comment[]) => {
      for (const comment of list) if (!comments.has(comment.sourceCommentId)) comments.set(comment.sourceCommentId, comment);
    };

    if (settings.captureComments) {
      addComments(parseCommentsHtml(workPageBody, { sourceWorkId, origin: this.source.origin, creatorProfileUrls }));
      const chapterIds = records.chapters
        .map((chapter) => chapter.sourceChapterId)
        .filter((id) => /^\d+$/.test(id));
      const seenChapterUrls = new Set<string>();
      for (const chapterId of chapterIds) {
        if (maximumCommentPages !== null && commentPages >= maximumCommentPages) break;
        let pageUrl: string | null = new URL(`/works/${sourceWorkId}/chapters/${chapterId}`, this.source.origin).toString();
        while (pageUrl) {
          if (maximumCommentPages !== null && commentPages >= maximumCommentPages) break;
          if (seenChapterUrls.has(pageUrl)) break;
          seenChapterUrls.add(pageUrl);
          const fetched = await this.fetchSocialPage(pageUrl);
          if (!fetched) break;
          commentPages++;
          responseBytes += Buffer.byteLength(fetched.body, "utf8");
          addComments(parseCommentsHtml(fetched.body, { sourceWorkId, origin: this.source.origin, creatorProfileUrls }));
          pageUrl = nextPageUrl(fetched.body, fetched.url);
        }
      }
    }

    if (settings.captureKudos) {
      let pageUrl: string | null = new URL(`/works/${sourceWorkId}/kudos`, this.source.origin).toString();
      let kudosPages = 0;
      const seenKudosUrls = new Set<string>();
      while (pageUrl) {
        if (maximumKudosPages !== null && kudosPages >= maximumKudosPages) break;
        if (seenKudosUrls.has(pageUrl)) break;
        seenKudosUrls.add(pageUrl);
        const fetched = await this.fetchSocialPage(pageUrl);
        if (!fetched) break;
        kudosPages++;
        responseBytes += Buffer.byteLength(fetched.body, "utf8");
        for (const kudo of parseKudosHtml(fetched.body, { sourceWorkId, origin: this.source.origin, observedAt: capturedAt })) {
          if (!kudos.has(kudo.sourceKudoId)) kudos.set(kudo.sourceKudoId, kudo);
        }
        pageUrl = nextPageUrl(fetched.body, fetched.url);
      }
    }

    if (settings.captureBookmarks) {
      let pageUrl: string | null = new URL(`/works/${sourceWorkId}/bookmarks`, this.source.origin).toString();
      let bookmarkPages = 0;
      const seenBookmarkUrls = new Set<string>();
      while (pageUrl) {
        if (maximumBookmarkPages !== null && bookmarkPages >= maximumBookmarkPages) break;
        if (seenBookmarkUrls.has(pageUrl)) break;
        seenBookmarkUrls.add(pageUrl);
        const fetched = await this.fetchSocialPage(pageUrl);
        if (!fetched) break;
        bookmarkPages++;
        responseBytes += Buffer.byteLength(fetched.body, "utf8");
        for (const bookmark of parseBookmarksHtml(fetched.body, { sourceWorkId, origin: this.source.origin })) {
          if (!bookmarks.has(bookmark.sourceBookmarkId)) bookmarks.set(bookmark.sourceBookmarkId, bookmark);
        }
        pageUrl = nextPageUrl(fetched.body, fetched.url);
      }
    }

    records.comments = [...comments.values()];
    records.kudos = [...kudos.values()];
    records.bookmarks = [...bookmarks.values()];
    return responseBytes;
  }

  /**
   * Fetch one social listing page, honoring the daily request budget via the
   * optional gate. Returns null when the page cannot be fetched (budget, pause,
   * or a non-200 response), so social capture stops without failing the work.
   */
  private async fetchSocialPage(url: string): Promise<FetchResult | null> {
    if (this.gate) {
      let reservation = await this.gate.reserve();
      if (!reservation.granted && reservation.retryAt) {
        await new Promise((resolve) => setTimeout(resolve, Math.max(0, reservation.retryAt!.getTime() - Date.now())));
        reservation = await this.gate.reserve();
      }
      if (!reservation.granted) return null;
    }
    try {
      const fetched = await this.fetcher.fetchText(url);
      return fetched.status >= 200 && fetched.status < 300 ? fetched : null;
    } catch {
      return null;
    }
  }

  private async sourceFailure(sourceWorkId: string, url: URL, error: SourceRequestError): Promise<TaskOutcome> {
    const availability = error.status === 404 ? "not_found" : error.status === 403 ? "restricted" : "unavailable";
    // Record the failed fetch outcome (no raw body) so it is visible in the AO3
    // fetches debug view alongside successful captures.
    await this.store.recordSnapshot({
      sourceId: this.source.id,
      sourceWorkId,
      url: url.toString(),
      httpStatus: error.status ?? 0,
      fetchedAt: new Date(),
      attempts: error.attempts,
    });
    if (error.status !== null) {
      await this.store.persistAvailability(this.source.id, {
        sourceWorkId,
        observedAt: new Date().toISOString(),
        availability,
        httpStatus: error.status,
        sourceUpdatedAt: null,
        contentHash: null,
      });
    }
    const notFound = error.status === 404;
    return {
      status: notFound ? "not_found" : error.retryable ? "retryable_failed" : "terminal_failed",
      code: error.status ? `http_${error.status}` : "network_failed",
      message: error.message,
      responseBytes: 0,
    };
  }
}
