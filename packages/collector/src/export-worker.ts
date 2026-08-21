import { MariaDbPackageExporter } from "./exporter.js";
import { ExportQueueStore } from "./export-queue.js";
import type { EventLog } from "./event-log.js";

export class ExportWorker {
  constructor(
    private readonly workerId: string,
    private readonly queue: ExportQueueStore,
    private readonly exporter: MariaDbPackageExporter,
    private readonly leaseMilliseconds = 300_000,
    private readonly events?: EventLog,
  ) {}

  async processOne(): Promise<boolean> {
    const claim = await this.queue.claim(this.workerId, this.leaseMilliseconds);
    if (!claim) return false;
    if (!await this.queue.markWriting(claim.id, claim.leaseToken)) return false;
    await this.events?.record({
      level: "info",
      event: "export_claimed",
      message: `Claimed export #${claim.id} (${claim.packageId}).`,
      context: { exportId: claim.id, packageId: claim.packageId, sourceId: claim.sourceId },
    });
    const timer = setInterval(() => void this.queue.heartbeat(claim.id, claim.leaseToken, this.leaseMilliseconds), Math.floor(this.leaseMilliseconds / 3));
    timer.unref();
    try {
      await this.exporter.processClaimed(claim);
      await this.events?.record({
        level: "info",
        event: "export_completed",
        message: `Export #${claim.id} completed.`,
        context: { exportId: claim.id, packageId: claim.packageId },
      });
    } catch (error) {
      await this.queue.markFailed(claim.id, claim.leaseToken, error);
      await this.events?.record({
        level: "error",
        event: "export_failed",
        message: `Export #${claim.id} failed: ${error instanceof Error ? error.message : String(error)}`,
        context: {
          exportId: claim.id,
          packageId: claim.packageId,
          error: error instanceof Error ? error.stack ?? error.message : String(error),
        },
      });
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
