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
    configuration: {
        start?: number;
        end?: number;
        batchSize?: number;
    };
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
export declare const api: {
    health: () => Promise<{
        status: string;
    }>;
    sources: () => Promise<{
        sources: Source[];
    }>;
    createSource: (body: {
        key: string;
        origin: string;
    }) => Promise<{
        sourceId: number;
        paused: boolean;
    }>;
    updateSource: (id: number, body: Pick<Source, "minimumDelayMs" | "dailyRequestBudget" | "paused">) => Promise<{
        updated: boolean;
    }>;
    jobs: () => Promise<{
        jobs: CollectionJob[];
    }>;
    job: (id: number) => Promise<{
        job: CollectionJob;
    }>;
    createJob: (body: {
        sourceId: number;
        start: number;
        end: number;
        batchSize: number;
    }) => Promise<{
        jobId: number;
    }>;
    controlJob: (id: number, action: "pause" | "resume" | "cancel") => Promise<{
        updated: boolean;
    }>;
    works: () => Promise<{
        works: WorkSummary[];
    }>;
};
