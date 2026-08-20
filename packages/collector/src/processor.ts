import type { Observation, TransferRecords } from "@ao3-offsite/contracts";
import {
  ParseError,
  SourceRequestError,
  parseEntireWorkHtml,
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

export type TaskOutcome =
  | { status: "succeeded"; localWorkId: number; contentHash: string; responseBytes: number }
  | { status: "not_found"; code: string; message: string; responseBytes: number }
  | { status: "retryable_failed"; code: string; message: string; responseBytes: number }
  | { status: "terminal_failed"; code: string; message: string; responseBytes: number };

export class WorkTaskProcessor {
  constructor(
    private readonly source: { id: number; origin: string; includeAdult: boolean },
    private readonly fetcher: SourceFetcher,
    private readonly blobs: RawBlobStore,
    private readonly store: CapturedWorkStore,
  ) {}

  async process(sourceWorkId: string): Promise<TaskOutcome> {
    if (!/^\d+$/.test(sourceWorkId)) return { status: "terminal_failed", code: "invalid_work_id", message: "Work ID must be numeric", responseBytes: 0 };
    let responseBytes = 0;
    const url = new URL(`/works/${sourceWorkId}`, this.source.origin);
    url.searchParams.set("view_full_work", "true");
    if (this.source.includeAdult) url.searchParams.set("view_adult", "true");

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
      const localWorkId = await this.store.persistCapturedWork(this.source.id, records);
      return { status: "succeeded", localWorkId, contentHash: records.works[0]!.contentHash, responseBytes };
    } catch (error) {
      if (error instanceof SourceRequestError) return this.sourceFailure(sourceWorkId, url, error);
      if (error instanceof ParseError) return { status: "terminal_failed", code: "parse_failed", message: error.message, responseBytes };
      return { status: "retryable_failed", code: "unexpected", message: error instanceof Error ? error.message : String(error), responseBytes };
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
