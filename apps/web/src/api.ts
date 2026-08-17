export interface Source {
  id: number;
  key: string;
  origin: string;
  minimumDelayMs: number;
  dailyRequestBudget: number | null;
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
  updateSource: (id: number, body: Pick<Source, "minimumDelayMs" | "dailyRequestBudget" | "paused">) => request<{ updated: boolean }>(`/api/sources/${id}`, {
    method: "PUT", body: JSON.stringify(body),
  }),
  jobs: () => request<{ jobs: CollectionJob[] }>("/api/jobs?limit=100&offset=0"),
  job: (id: number) => request<{ job: CollectionJob }>(`/api/jobs/${id}`),
  createJob: (body: { sourceId: number; start: number; end: number; batchSize: number }) => request<{ jobId: number }>("/api/jobs/id-range", {
    method: "POST", body: JSON.stringify(body),
  }),
  controlJob: (id: number, action: "pause" | "resume" | "cancel") => request<{ updated: boolean }>(`/api/jobs/${id}/${action}`, { method: "POST" }),
  works: () => request<{ works: WorkSummary[] }>("/api/works?limit=100&offset=0"),
};
