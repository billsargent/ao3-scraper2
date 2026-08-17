import { hostname } from "node:os";
import { JobPlannerStore, JobPlannerWorker } from "@ao3-offsite/collector";
import { createDatabase } from "@ao3-offsite/database";

const databaseUrl = process.env.COLLECTOR_DATABASE_URL;
if (!databaseUrl) throw new Error("COLLECTOR_DATABASE_URL is required");
const { db, pool } = createDatabase(databaseUrl);
const workerId = process.env.PLANNER_WORKER_ID ?? `${hostname()}:${process.pid}`;
const worker = new JobPlannerWorker(workerId, new JobPlannerStore(db));
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => controller.abort());
try {
  console.log(JSON.stringify({ event: "planner_worker_started", workerId }));
  await worker.run(controller.signal);
} finally {
  await pool.end();
  console.log(JSON.stringify({ event: "planner_worker_stopped" }));
}
