import { hostname } from "node:os";
import { ExportQueueStore, ExportWorker, MariaDbPackageExporter } from "@ao3-offsite/collector";
import { createDatabase } from "@ao3-offsite/database";

const databaseUrl = process.env.COLLECTOR_DATABASE_URL;
if (!databaseUrl) throw new Error("COLLECTOR_DATABASE_URL is required");
const { db, pool } = createDatabase(databaseUrl);
const workerId = process.env.EXPORT_WORKER_ID ?? `${hostname()}:${process.pid}`;
const worker = new ExportWorker(workerId, new ExportQueueStore(db), new MariaDbPackageExporter(db));
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort());
try {
  console.log(JSON.stringify({ event: "export_worker_started", workerId }));
  await worker.run(controller.signal);
} finally {
  await pool.end();
  console.log(JSON.stringify({ event: "export_worker_stopped" }));
}
