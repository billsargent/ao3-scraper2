import { MariaDbPackageExporter } from "./exporter.js";
import { ExportQueueStore } from "./export-queue.js";

export class ExportWorker {
  constructor(
    private readonly workerId: string,
    private readonly queue: ExportQueueStore,
    private readonly exporter: MariaDbPackageExporter,
    private readonly leaseMilliseconds = 300_000,
  ) {}

  async processOne(): Promise<boolean> {
    const claim = await this.queue.claim(this.workerId, this.leaseMilliseconds);
    if (!claim) return false;
    if (!await this.queue.markWriting(claim.id, claim.leaseToken)) return false;
    const timer = setInterval(() => void this.queue.heartbeat(claim.id, claim.leaseToken, this.leaseMilliseconds), Math.floor(this.leaseMilliseconds / 3));
    timer.unref();
    try {
      await this.exporter.processClaimed(claim);
    } catch (error) {
      await this.queue.markFailed(claim.id, claim.leaseToken, error);
    } finally {
      clearInterval(timer);
    }
    return true;
  }

  async run(signal: AbortSignal, idleMilliseconds = 2_000): Promise<void> {
    while (!signal.aborted) {
      if (!await this.processOne()) await new Promise((resolve) => setTimeout(resolve, idleMilliseconds));
    }
  }
}
