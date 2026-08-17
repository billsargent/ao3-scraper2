import { readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CollectorStore, ExportQueueStore, ExportWorker, MariaDbPackageExporter } from "@ao3-offsite/collector";
import { createDatabase, sources } from "@ao3-offsite/database";
import { parseEntireWorkHtml } from "@ao3-offsite/scraper-core";

const [outputRootArgument] = process.argv.slice(2);
if (!outputRootArgument) {
  console.error("Usage: build-e2e-package <output-root>");
  process.exit(2);
}
const outputRoot = resolve(outputRootArgument);
await rm(outputRoot, { recursive: true, force: true });
const { db, pool } = createDatabase();
try {
  const sourceKey = `e2e-${Date.now()}`;
  const sourceId = (await db.insert(sources).values({
    key: sourceKey,
    origin: "https://archiveofourown.org",
    paused: true,
  }).$returningId())[0]!.id;
  const html = await readFile(fileURLToPath(new URL("../packages/scraper-core/test/fixtures/work-entire.html", import.meta.url)), "utf8");
  const records = parseEntireWorkHtml(html, {
    sourceUrl: "https://archiveofourown.org/works/12345?view_full_work=true&view_adult=true",
    capturedAt: new Date().toISOString(),
  });
  await new CollectorStore(db).persistCapturedWork(sourceId, records);
  const queue = new ExportQueueStore(db);
  const request = await queue.createRequest(sourceId, outputRoot, 100);
  const worker = new ExportWorker("e2e-export-worker", queue, new MariaDbPackageExporter(db), 30_000);
  if (!await worker.processOne()) throw new Error("Export worker did not claim the E2E request");
  const run = (await db.query.exportRuns.findFirst({ where: (table, { eq }) => eq(table.id, request.id) }));
  if (!run || run.status !== "completed") throw new Error(`E2E export did not complete: ${run?.status ?? "missing"}`);
  console.log(JSON.stringify({ packageId: request.packageId, packageDirectory: run.outputDirectory, archivePath: run.archivePath }, null, 2));
} finally {
  await pool.end();
}
