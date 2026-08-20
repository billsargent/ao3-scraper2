export interface Source {
  id: number;
  key: string;
  origin: string;
  userAgent: string;
  includeAdult: boolean;
  minimumDelayMs: number;
  dailyRequestBudget: number | null;
  dailyByteBudget: number | null;
  requestTimeoutMs: number;
  maximumResponseBytes: number;
  maximumFailureAttempts: number;
  operatingWindowStartHourUtc: number | null;
  operatingWindowEndHourUtc: number | null;
  captureComments: boolean;
  captureKudos: boolean;
  captureBookmarks: boolean;
  maximumCommentPages: number | null;
  maximumKudosPages: number | null;
  maximumBookmarkPages: number | null;
  paused: boolean;
  nextRequestAt: string | null;
  todayUsage?: { requests: number; bytes: number };
}

export interface CollectionJob {
  id: number;
  sourceId: number;
  type: string;
  status: "queued" | "running" | "paused" | "completed" | "failed" | "cancelled";
  configuration: { start?: number; end?: number; batchSize?: number };
  planningStatus: "queued" | "leased" | "planning" | "completed" | "failed";
  planningCursor: number | null;
  planningError: string | null;
  discoveredCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  taskCounts?: Record<string, number>;
}

export interface ExportRecord {
  id: number;
  sourceId: number;
  packageId: string;
  previousPackageId: string | null;
  sequenceNumber: number | null;
  status: "queued" | "leased" | "writing" | "completed" | "empty" | "failed";
  outputDirectory: string;
  maximumWorks: number;
  workCount: number;
  errorMessage: string | null;
  archivePath: string | null;
  archiveHash: string | null;
  archiveBytes: number | null;
  verifiedAt: string | null;
  importStatus: "not_imported" | "importing" | "imported" | "failed";
  importStartedAt: string | null;
  importedAt: string | null;
  importError: string | null;
  otwImportRunId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface ExportManifest {
  manifest: {
    packageId: string;
    packageType: "snapshot" | "incremental";
    createdAt: string;
    records: Record<string, number>;
  };
  checksums: string;
  archiveHash: string;
  archiveBytes: number;
  verifiedAt: string;
}

export interface FailureRecord {
  taskId: number;
  jobId: number;
  sourceWorkId: string;
  status: string;
  attempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  availableAt: string;
  updatedAt: string;
}

export interface WorkSummary {
  id: number;
  sourceWorkId: string;
  title: string;
  languageCode: string;
  complete: boolean;
  expectedChapters: number | null;
  words: number | null;
  availability: string;
  sourceUpdatedAt: string | null;
  lastSeenAt: string;
}

export interface ChapterSummary {
  id: number;
  sourceChapterId: string;
  position: number;
  title: string;
  wordCount: number | null;
  contentHash: string;
}

export interface WorkDetail extends WorkSummary {
  sourceUrl: string;
  summaryHtml: string;
  notesHtml: string;
  endNotesHtml: string;
  contentHash: string;
  chapters: ChapterSummary[];
  authors: Array<{ sourceAuthorId: string; name: string; profileUrl: string | null; anonymous: boolean; orphaned: boolean; position: number }>;
  tags: Array<{ sourceTagId: string; type: string; name: string; canonical: boolean | null; sourceUrl: string | null; position: number }>;
  series: Array<{ sourceSeriesId: string; name: string; sourceUrl: string; position: number }>;
}

export interface ChapterDetail extends ChapterSummary {
  summaryHtml: string;
  notesHtml: string;
  contentHtml: string;
  endNotesHtml: string;
  publishedAt: string | null;
}

const TOKEN_KEY = "archive-relay-api-token";

export interface DebugEntry {
  id: number;
  timestamp: string;
  method: string;
  path: string;
  status: number | null;
  durationMs: number;
  outcome: "success" | "error" | "network_error";
  message: string;
  requestId?: string;
  issues?: ApiValidationIssue[];
}

let nextDebugId = 1;
let debugEntries: DebugEntry[] = [];
const debugListeners = new Set<() => void>();

function recordDebug(entry: Omit<DebugEntry, "id" | "timestamp">) {
  debugEntries = [{ id: nextDebugId++, timestamp: new Date().toISOString(), ...entry }, ...debugEntries].slice(0, 200);
  debugListeners.forEach((listener) => listener());
}

export function getDebugEntries(): DebugEntry[] { return debugEntries; }
export function subscribeDebug(listener: () => void): () => void { debugListeners.add(listener); return () => debugListeners.delete(listener); }
export function clearDebugEntries(): void { debugEntries = []; debugListeners.forEach((listener) => listener()); }

export interface ApiValidationIssue {
  path?: Array<string | number>;
  message?: string;
}

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly issues: ApiValidationIssue[] = []) {
    super(message);
    this.name = "ApiError";
  }
}

export function getApiToken(): string { return localStorage.getItem(TOKEN_KEY) ?? ""; }
export function setApiToken(token: string): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function streamEvents(
  onEvent: (event: { type: string; data: unknown }) => void,
  signal: AbortSignal,
): Promise<void> {
  const token = getApiToken();
  const response = await fetch("/api/events", {
    signal,
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok || !response.body) throw new ApiError("Unable to open event stream", response.status);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (!signal.aborted) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const eventType = block.split("\n").find((line) => line.startsWith("event:"))?.slice(6).trim() ?? "message";
      const dataLines = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart());
      if (dataLines.length) {
        try { onEvent({ type: eventType, data: JSON.parse(dataLines.join("\n")) }); } catch { /* Ignore malformed event payloads. */ }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const token = getApiToken();
  const method = options?.method ?? "GET";
  const startedAt = performance.now();
  try {
    const headers = new Headers(options?.headers);
    if (options?.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
    if (token) headers.set("authorization", `Bearer ${token}`);
    const response = await fetch(path, {
      ...options,
      headers,
    });
    const durationMs = Math.round(performance.now() - startedAt);
    if (!response.ok) {
      const data = await response.json().catch(() => null) as { error?: string; issues?: ApiValidationIssue[]; message?: string; requestId?: string } | null;
      const issues = data?.issues ?? [];
      const detailedMessage = issues.length
        ? issues.map((issue) => `${issue.path?.join(".") || "value"}: ${issue.message || "is invalid"}`).join("; ")
        : data?.message ?? data?.error ?? `Request failed with HTTP ${response.status}`;
      recordDebug({ method, path, status: response.status, durationMs, outcome: "error", message: detailedMessage, issues, ...(data?.requestId ? { requestId: data.requestId } : {}) });
      throw new ApiError(detailedMessage, response.status, issues);
    }
    recordDebug({ method, path, status: response.status, durationMs, outcome: "success", message: "Request completed" });
    return response.json() as Promise<T>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    recordDebug({ method, path, status: null, durationMs: Math.round(performance.now() - startedAt), outcome: "network_error", message });
    throw new ApiError(message, 0);
  }
}

export interface CollectorStatistics {
  works: number;
  words: number;
  chapters: number;
  authors: number;
  activeJobs: number;
  terminalFailures: number;
}

export interface SystemSettings {
  backupRetentionDays: number | null;
  defaultBatchSize: number;
  timezone: string;
}

export interface SystemInfo {
  dataDirectory: string;
  exportDirectory: string;
  authEnabled: boolean;
  appCommit: string;
}

export interface FetchSnapshot {
  id: number;
  sourceWorkId: string | null;
  url: string;
  httpStatus: number;
  fetchedAt: string;
  parserVersion: string | null;
  responseBytes: number | null;
  attempts: number;
}

export const api = {
  health: () => request<{ status: string; commit: string }>("/api/health/ready"),
  statistics: () => request<{ statistics: CollectorStatistics }>("/api/statistics"),
  sources: () => request<{ sources: Source[] }>("/api/sources"),
  createSource: (body: { key: string; origin: string }) => request<{ sourceId: number; paused: boolean }>("/api/sources", {
    method: "POST", body: JSON.stringify(body),
  }),
  updateSource: (id: number, body: Pick<Source, "userAgent" | "includeAdult" | "minimumDelayMs" | "dailyRequestBudget" | "dailyByteBudget" | "requestTimeoutMs" | "maximumResponseBytes" | "maximumFailureAttempts" | "operatingWindowStartHourUtc" | "operatingWindowEndHourUtc" | "captureComments" | "captureKudos" | "captureBookmarks" | "maximumCommentPages" | "maximumKudosPages" | "maximumBookmarkPages" | "paused">) => request<{ updated: boolean }>(`/api/sources/${id}`, {
    method: "PUT", body: JSON.stringify(body),
  }),
  jobs: () => request<{ jobs: CollectionJob[] }>("/api/jobs?limit=100&offset=0"),
  job: (id: number) => request<{ job: CollectionJob }>(`/api/jobs/${id}`),
  createJob: (body: { sourceId: number; start: number; end: number; batchSize: number }) => request<{ jobId: number }>("/api/jobs/id-range", {
    method: "POST", body: JSON.stringify(body),
  }),
  controlJob: (id: number, action: "pause" | "resume" | "cancel") => request<{ updated: boolean }>(`/api/jobs/${id}/${action}`, { method: "POST" }),
  retryFailures: (id: number) => request<{ updated: boolean }>(`/api/jobs/${id}/retry-failures`, { method: "POST" }),
  failures: (page = 0, limit = 25) => request<{ failures: FailureRecord[]; total: number }>(`/api/failures?limit=${limit}&offset=${page * limit}`),
  exports: (page = 0, limit = 25) => request<{ exports: ExportRecord[]; total: number }>(`/api/exports?limit=${limit}&offset=${page * limit}`),
  createExport: (body: { sourceId: number; maximumWorks: number }) => request<{ id: number; packageId: string }>("/api/exports", { method: "POST", body: JSON.stringify(body) }),
  exportDetail: (id: number) => request<{ export: ExportRecord }>(`/api/exports/${id}`),
  exportManifest: (id: number) => request<ExportManifest>(`/api/exports/${id}/manifest`),
  updateImportStatus: (id: number, body: { status: ExportRecord["importStatus"]; error?: string | null; otwImportRunId?: string | null }) => request<{ updated: boolean }>(`/api/exports/${id}/import-status`, { method: "PATCH", body: JSON.stringify(body) }),
  downloadExport: async (id: number) => {
    const token = getApiToken();
    const response = await fetch(`/api/exports/${id}/download`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    if (!response.ok) throw new ApiError("Package download is not ready", response.status);
    const disposition = response.headers.get("content-disposition") ?? "";
    const fileName = disposition.match(/filename="([^"]+)"/)?.[1] ?? `archive-relay-export-${id}.tar.gz`;
    return { blob: await response.blob(), fileName, hash: response.headers.get("x-content-sha256") };
  },
  verifyExport: (id: number) => request<{ verified: boolean; archiveHash: string; currentHash: string; bytes: number }>(`/api/exports/${id}/verify`, { method: "POST" }),
  settings: () => request<{ settings: SystemSettings; system: SystemInfo }>("/api/settings"),
  updateSettings: (body: { backupRetentionDays?: number | null | undefined; defaultBatchSize?: number | undefined; timezone?: string | undefined }) => request<{ settings: SystemSettings }>("/api/settings", { method: "PUT", body: JSON.stringify(body) }),
  fetches: (page = 0, limit = 25) => request<{ fetches: FetchSnapshot[]; total: number; limit: number; offset: number }>(`/api/fetches?limit=${limit}&offset=${page * limit}`),
  works: (page = 0, limit = 25, query = "") => request<{ works: WorkSummary[]; total: number; limit: number; offset: number }>(`/api/works?limit=${limit}&offset=${page * limit}&q=${encodeURIComponent(query)}`),
  work: (id: number) => request<{ work: WorkDetail }>(`/api/works/${id}`),
  chapter: (workId: number, chapterId: number) => request<{ chapter: ChapterDetail }>(`/api/works/${workId}/chapters/${chapterId}`),
};
