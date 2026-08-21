import { hostname } from "node:os";
import { EventLog, ExportQueueStore, ExportWorker, MariaDbPackageExporter } from "@ao3-offsite/collector";
import { createDatabase } from "@ao3-offsite/database";

const databaseUrl = process.env.COLLECTOR_DATABASE_URL;
if (!databaseUrl) throw new Error("COLLECTOR_DATABASE_URL is required");
const { db, pool } = createDatabase(databaseUrl);
const workerId = process.env.EXPORT_WORKER_ID ?? `${hostname()}:${process.pid}`;
const events = new EventLog(db, { service: "export", workerId });
const worker = new ExportWorker(workerId, new ExportQueueStore(db), new MariaDbPackageExporter(db), 300_000, events);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort());
try {
  console.log(JSON.stringify({ event: "export_worker_started", workerId }));
  await events.record({ level: "info", event: "export_worker_started", message: "Export worker started." });
  await worker.run(controller.signal);
} finally {
  await events.record({ level: "info", event: "export_worker_stopped", message: "Export worker stopped." });
  await pool.end();
  console.log(JSON.stringify({ event: "export_worker_stopped" }));
}
