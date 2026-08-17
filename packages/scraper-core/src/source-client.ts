export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface SourceClientOptions {
  origin: string;
  userAgent: string;
  minimumDelayMs?: number;
  timeoutMs?: number;
  maximumAttempts?: number;
  maximumBodyBytes?: number;
  fetch?: FetchLike;
  sleep?: (milliseconds: number) => Promise<void>;
  now?: () => number;
}

export interface FetchResult {
  url: string;
  status: number;
  body: string;
  fetchedAt: string;
  attempts: number;
  responseHeaders: Record<string, string>;
}

export class SourceRequestError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "SourceRequestError";
  }
}

const defaultSleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export class PoliteSourceClient {
  private readonly origin: string;
  private readonly userAgent: string;
  private readonly minimumDelayMs: number;
  private readonly timeoutMs: number;
  private readonly maximumAttempts: number;
  private readonly maximumBodyBytes: number;
  private readonly fetchImplementation: FetchLike;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly now: () => number;
  private queue: Promise<void> = Promise.resolve();
  private nextRequestAt = 0;

  constructor(options: SourceClientOptions) {
    this.origin = new URL(options.origin).origin;
    this.userAgent = options.userAgent.trim();
    if (!this.userAgent) throw new Error("A descriptive User-Agent is required");
    this.minimumDelayMs = options.minimumDelayMs ?? 5_000;
    if (this.minimumDelayMs < 2_000) throw new Error("minimumDelayMs cannot be lower than 2000ms");
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maximumAttempts = options.maximumAttempts ?? 3;
    this.maximumBodyBytes = options.maximumBodyBytes ?? 20 * 1024 * 1024;
    this.fetchImplementation = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  async fetchText(input: string | URL): Promise<FetchResult> {
    const url = new URL(input, this.origin);
    if (url.origin !== this.origin) throw new SourceRequestError(`Refusing request outside configured origin: ${url.origin}`, false);
    return this.exclusive(async () => {
      let lastError: SourceRequestError | null = null;
      for (let attempt = 1; attempt <= this.maximumAttempts; attempt += 1) {
        await this.waitForRequestSlot();
        try {
          const response = await this.fetchImplementation(url, {
            redirect: "follow",
            headers: { "User-Agent": this.userAgent, Accept: "text/html,application/xhtml+xml" },
            signal: AbortSignal.timeout(this.timeoutMs),
          });
          this.nextRequestAt = this.now() + this.minimumDelayMs;
          if (new URL(response.url || url.toString()).origin !== this.origin) {
            throw new SourceRequestError(`Refusing redirect outside configured origin`, false, response.status);
          }
          if (response.ok) {
            const declaredLength = Number.parseInt(response.headers.get("content-length") ?? "0", 10);
            if (declaredLength > this.maximumBodyBytes) throw new SourceRequestError(`Response exceeds body limit`, false, response.status);
            const body = await response.text();
            if (Buffer.byteLength(body, "utf8") > this.maximumBodyBytes) throw new SourceRequestError(`Response exceeds body limit`, false, response.status);
            const responseHeaders = Object.fromEntries(
              ["content-type", "content-length", "etag", "last-modified", "cache-control"]
                .map((name) => [name, response.headers.get(name)] as const)
                .filter((entry): entry is readonly [string, string] => entry[1] !== null),
            );
            return { url: url.toString(), status: response.status, body, fetchedAt: new Date().toISOString(), attempts: attempt, responseHeaders };
          }

          const retryable = response.status === 429 || response.status === 503 || response.status >= 500;
          lastError = new SourceRequestError(`Source returned HTTP ${response.status}`, retryable, response.status);
          if (!retryable || attempt === this.maximumAttempts) throw lastError;
          await this.sleep(this.retryDelay(response, attempt));
        } catch (error) {
          this.nextRequestAt = Math.max(this.nextRequestAt, this.now() + this.minimumDelayMs);
          if (error instanceof SourceRequestError) {
            if (!error.retryable || attempt === this.maximumAttempts) throw error;
            lastError = error;
          } else {
            lastError = new SourceRequestError(`Source request failed: ${String(error)}`, true);
            if (attempt === this.maximumAttempts) throw lastError;
            await this.sleep(this.exponentialDelay(attempt));
          }
        }
      }
      throw lastError ?? new SourceRequestError("Source request failed", true);
    });
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.queue;
    let release!: () => void;
    this.queue = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async waitForRequestSlot(): Promise<void> {
    const wait = this.nextRequestAt - this.now();
    if (wait > 0) await this.sleep(wait);
  }

  private retryDelay(response: Response, attempt: number): number {
    const retryAfter = response.headers.get("retry-after");
    if (retryAfter) {
      const seconds = Number.parseFloat(retryAfter);
      if (Number.isFinite(seconds)) return Math.max(this.minimumDelayMs, seconds * 1_000);
      const date = Date.parse(retryAfter);
      if (Number.isFinite(date)) return Math.max(this.minimumDelayMs, date - Date.now());
    }
    return this.exponentialDelay(attempt);
  }

  private exponentialDelay(attempt: number): number {
    return Math.max(this.minimumDelayMs, Math.min(5 * 60_000, 2 ** attempt * 1_000));
  }
}
