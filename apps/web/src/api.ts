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
  discoveredCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  taskCounts?: Record<string, number>;
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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...options?.headers },
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    throw new Error(data?.error ?? `Request failed with HTTP ${response.status}`);
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
  works: (page = 0, limit = 25, query = "") => request<{ works: WorkSummary[]; total: number; limit: number; offset: number }>(`/api/works?limit=${limit}&offset=${page * limit}&q=${encodeURIComponent(query)}`),
  work: (id: number) => request<{ work: WorkDetail }>(`/api/works/${id}`),
  chapter: (workId: number, chapterId: number) => request<{ chapter: ChapterDetail }>(`/api/works/${workId}/chapters/${chapterId}`),
};
