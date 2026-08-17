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
  paused: boolean;
  nextRequestAt: string | null;
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
  status: "queued" | "leased" | "writing" | "completed" | "empty" | "failed";
  outputDirectory: string;
  maximumWorks: number;
  workCount: number;
  errorMessage: string | null;
  createdAt: string;
  completedAt: string | null;
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
}

export interface ChapterDetail extends ChapterSummary {
  summaryHtml: string;
  notesHtml: string;
  contentHtml: string;
  endNotesHtml: string;
  publishedAt: string | null;
}

const TOKEN_KEY = "archive-relay-api-token";

export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "ApiError"; }
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
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...options?.headers },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new ApiError(data?.error ?? `Request failed with HTTP ${response.status}`, response.status);
  }
  return response.json() as Promise<T>;
}

export const api = {
  health: () => request<{ status: string }>("/api/health/ready"),
  sources: () => request<{ sources: Source[] }>("/api/sources"),
  createSource: (body: { key: string; origin: string }) => request<{ sourceId: number; paused: boolean }>("/api/sources", {
    method: "POST", body: JSON.stringify(body),
  }),
  updateSource: (id: number, body: Pick<Source, "userAgent" | "includeAdult" | "minimumDelayMs" | "dailyRequestBudget" | "dailyByteBudget" | "requestTimeoutMs" | "maximumResponseBytes" | "maximumFailureAttempts" | "operatingWindowStartHourUtc" | "operatingWindowEndHourUtc" | "paused">) => request<{ updated: boolean }>(`/api/sources/${id}`, {
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
  works: (page = 0, limit = 25, query = "") => request<{ works: WorkSummary[]; total: number; limit: number; offset: number }>(`/api/works?limit=${limit}&offset=${page * limit}&q=${encodeURIComponent(query)}`),
  work: (id: number) => request<{ work: WorkDetail }>(`/api/works/${id}`),
  chapter: (workId: number, chapterId: number) => request<{ chapter: ChapterDetail }>(`/api/works/${workId}/chapters/${chapterId}`),
};
