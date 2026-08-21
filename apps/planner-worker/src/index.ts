import { hostname } from "node:os";
import { EventLog, JobPlannerStore, JobPlannerWorker } from "@ao3-offsite/collector";
import { createDatabase } from "@ao3-offsite/database";

const databaseUrl = process.env.COLLECTOR_DATABASE_URL;
if (!databaseUrl) throw new Error("COLLECTOR_DATABASE_URL is required");
const { db, pool } = createDatabase(databaseUrl);
const workerId = process.env.PLANNER_WORKER_ID ?? `${hostname()}:${process.pid}`;
const events = new EventLog(db, { service: "planner", workerId });
const worker = new JobPlannerWorker(workerId, new JobPlannerStore(db), 120_000, events);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort());
try {
  console.log(JSON.stringify({ event: "planner_worker_started", workerId }));
  await events.record({ level: "info", event: "planner_worker_started", message: "Planner worker started." });
  await worker.run(controller.signal);
} finally {
  await events.record({ level: "info", event: "planner_worker_stopped", message: "Planner worker stopped." });
  await pool.end();
  console.log(JSON.stringify({ event: "planner_worker_stopped" }));
}
