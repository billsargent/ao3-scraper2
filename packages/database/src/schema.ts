import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  char,
  customType,
  date,
  datetime,
  index,
  int,
  json,
  mysqlEnum,
  mysqlTable,
  primaryKey,
  text,
  uniqueIndex,
  varchar,
} from "drizzle-orm/mysql-core";

const longtext = customType<{ data: string }>({ dataType: () => "longtext" });
const id = (name = "id") => bigint(name, { mode: "number", unsigned: true }).autoincrement().primaryKey();
const foreignId = (name: string) => bigint(name, { mode: "number", unsigned: true });
const timestamps = {
  createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  updatedAt: datetime("updated_at", { mode: "date", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`).$onUpdateFn(() => new Date()),
};

export const sources = mysqlTable("sources", {
  id: id(),
  key: varchar("source_key", { length: 100 }).notNull(),
  origin: varchar("origin", { length: 500 }).notNull(),
  minimumDelayMs: int("minimum_delay_ms", { unsigned: true }).notNull().default(10000),
  dailyRequestBudget: int("daily_request_budget", { unsigned: true }).default(250),
  paused: boolean("paused").notNull().default(false),
  nextRequestAt: datetime("next_request_at", { mode: "date", fsp: 3 }),
  ...timestamps,
}, (table) => [uniqueIndex("sources_key_unique").on(table.key)]);

export const sourceDailyUsage = mysqlTable("source_daily_usage", {
  sourceId: foreignId("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
  usageDate: date("usage_date", { mode: "string" }).notNull(),
  requestCount: int("request_count", { unsigned: true }).notNull().default(0),
  responseBytes: bigint("response_bytes", { mode: "number", unsigned: true }).notNull().default(0),
  ...timestamps,
}, (table) => [primaryKey({ columns: [table.sourceId, table.usageDate] })]);

export const collectionJobs = mysqlTable("collection_jobs", {
  id: id(),
  sourceId: foreignId("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  type: mysqlEnum("job_type", ["id_range", "explicit_ids", "refresh"]).notNull(),
  status: mysqlEnum("status", ["queued", "running", "paused", "completed", "failed", "cancelled"]).notNull().default("queued"),
  configuration: json("configuration").$type<Record<string, unknown>>().notNull(),
  discoveredCount: int("discovered_count", { unsigned: true }).notNull().default(0),
  succeededCount: int("succeeded_count", { unsigned: true }).notNull().default(0),
  failedCount: int("failed_count", { unsigned: true }).notNull().default(0),
  skippedCount: int("skipped_count", { unsigned: true }).notNull().default(0),
  startedAt: datetime("started_at", { mode: "date", fsp: 3 }),
  completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
  ...timestamps,
}, (table) => [index("collection_jobs_source_status").on(table.sourceId, table.status)]);

export const exportRuns = mysqlTable("export_runs", {
  id: id(),
  sourceId: foreignId("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  packageId: char("package_id", { length: 36 }).notNull(),
  previousPackageId: char("previous_package_id", { length: 36 }),
  status: mysqlEnum("status", ["writing", "completed", "failed"]).notNull().default("writing"),
  outputDirectory: varchar("output_directory", { length: 1500 }).notNull(),
  workCount: int("work_count", { unsigned: true }).notNull().default(0),
  errorMessage: text("error_message"),
  completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
  ...timestamps,
}, (table) => [
  uniqueIndex("export_runs_package_unique").on(table.packageId),
  index("export_runs_source_status").on(table.sourceId, table.status, table.completedAt),
]);

export const collectionTasks = mysqlTable("collection_tasks", {
  id: id(),
  jobId: foreignId("job_id").notNull().references(() => collectionJobs.id, { onDelete: "cascade" }),
  sourceWorkId: varchar("source_work_id", { length: 255 }).notNull(),
  status: mysqlEnum("status", ["queued", "leased", "succeeded", "retryable_failed", "terminal_failed", "cancelled"]).notNull().default("queued"),
  attempts: int("attempts", { unsigned: true }).notNull().default(0),
  availableAt: datetime("available_at", { mode: "date", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
  leaseExpiresAt: datetime("lease_expires_at", { mode: "date", fsp: 3 }),
  leasedBy: varchar("leased_by", { length: 255 }),
  lastErrorCode: varchar("last_error_code", { length: 100 }),
  lastErrorMessage: text("last_error_message"),
  ...timestamps,
}, (table) => [
  uniqueIndex("collection_tasks_job_work_unique").on(table.jobId, table.sourceWorkId),
  index("collection_tasks_claim").on(table.status, table.availableAt, table.leaseExpiresAt),
]);

export const works = mysqlTable("works", {
  id: id(),
  sourceId: foreignId("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  sourceWorkId: varchar("source_work_id", { length: 255 }).notNull(),
  sourceUrl: varchar("source_url", { length: 1000 }).notNull(),
  title: text("title").notNull(),
  summaryHtml: longtext("summary_html").notNull(),
  notesHtml: longtext("notes_html").notNull(),
  endNotesHtml: longtext("end_notes_html").notNull(),
  languageCode: varchar("language_code", { length: 20 }).notNull(),
  publishedAt: date("published_at", { mode: "string" }),
  sourceUpdatedAt: date("source_updated_at", { mode: "string" }),
  complete: boolean("complete").notNull(),
  restricted: boolean("restricted").notNull(),
  expectedChapters: int("expected_chapters", { unsigned: true }),
  words: bigint("words", { mode: "number", unsigned: true }),
  contentHash: char("content_hash", { length: 71 }).notNull(),
  availability: mysqlEnum("availability", ["public", "restricted", "not_found", "unavailable", "unknown"]).notNull().default("public"),
  firstSeenAt: datetime("first_seen_at", { mode: "date", fsp: 3 }).notNull(),
  lastSeenAt: datetime("last_seen_at", { mode: "date", fsp: 3 }).notNull(),
  lastSuccessfulCaptureAt: datetime("last_successful_capture_at", { mode: "date", fsp: 3 }),
  lastExportedHash: char("last_exported_hash", { length: 71 }),
  lastExportedAt: datetime("last_exported_at", { mode: "date", fsp: 3 }),
  lastExportPackageId: char("last_export_package_id", { length: 36 }),
  ...timestamps,
}, (table) => [
  uniqueIndex("works_source_identity_unique").on(table.sourceId, table.sourceWorkId),
  index("works_refresh").on(table.availability, table.sourceUpdatedAt, table.lastSeenAt),
]);

export const authors = mysqlTable("authors", {
  id: id(),
  sourceId: foreignId("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  sourceAuthorId: varchar("source_author_id", { length: 255 }).notNull(),
  name: varchar("name", { length: 255 }).notNull(),
  profileUrl: varchar("profile_url", { length: 1000 }),
  anonymous: boolean("anonymous").notNull().default(false),
  orphaned: boolean("orphaned").notNull().default(false),
  ...timestamps,
}, (table) => [uniqueIndex("authors_source_identity_unique").on(table.sourceId, table.sourceAuthorId)]);

export const workAuthors = mysqlTable("work_authors", {
  workId: foreignId("work_id").notNull().references(() => works.id, { onDelete: "cascade" }),
  authorId: foreignId("author_id").notNull().references(() => authors.id, { onDelete: "restrict" }),
  position: int("position", { unsigned: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.workId, table.authorId] }),
  index("work_authors_order").on(table.workId, table.position),
]);

export const chapters = mysqlTable("chapters", {
  id: id(),
  workId: foreignId("work_id").notNull().references(() => works.id, { onDelete: "cascade" }),
  sourceChapterId: varchar("source_chapter_id", { length: 255 }).notNull(),
  position: int("position", { unsigned: true }).notNull(),
  title: text("title").notNull(),
  summaryHtml: longtext("summary_html").notNull(),
  notesHtml: longtext("notes_html").notNull(),
  contentHtml: longtext("content_html").notNull(),
  endNotesHtml: longtext("end_notes_html").notNull(),
  publishedAt: date("published_at", { mode: "string" }),
  wordCount: int("word_count", { unsigned: true }),
  contentHash: char("content_hash", { length: 71 }).notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("chapters_work_source_unique").on(table.workId, table.sourceChapterId),
  uniqueIndex("chapters_work_position_unique").on(table.workId, table.position),
]);

export const tags = mysqlTable("tags", {
  id: id(),
  sourceId: foreignId("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  sourceTagId: varchar("source_tag_id", { length: 255 }).notNull(),
  type: mysqlEnum("tag_type", ["Rating", "ArchiveWarning", "Category", "Fandom", "Relationship", "Character", "Freeform"]).notNull(),
  name: text("name").notNull(),
  canonical: boolean("canonical"),
  sourceUrl: varchar("source_url", { length: 1000 }),
  ...timestamps,
}, (table) => [uniqueIndex("tags_source_identity_unique").on(table.sourceId, table.sourceTagId)]);

export const workTags = mysqlTable("work_tags", {
  workId: foreignId("work_id").notNull().references(() => works.id, { onDelete: "cascade" }),
  tagId: foreignId("tag_id").notNull().references(() => tags.id, { onDelete: "restrict" }),
  position: int("position", { unsigned: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.workId, table.tagId] }),
  index("work_tags_order").on(table.workId, table.position),
]);

export const series = mysqlTable("series", {
  id: id(),
  sourceId: foreignId("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  sourceSeriesId: varchar("source_series_id", { length: 255 }).notNull(),
  sourceUrl: varchar("source_url", { length: 1000 }).notNull(),
  name: text("name").notNull(),
  summaryHtml: longtext("summary_html").notNull(),
  complete: boolean("complete"),
  ...timestamps,
}, (table) => [uniqueIndex("series_source_identity_unique").on(table.sourceId, table.sourceSeriesId)]);

export const seriesWorks = mysqlTable("series_works", {
  seriesId: foreignId("series_id").notNull().references(() => series.id, { onDelete: "cascade" }),
  workId: foreignId("work_id").notNull().references(() => works.id, { onDelete: "cascade" }),
  position: int("position", { unsigned: true }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.seriesId, table.workId] }),
  uniqueIndex("series_works_position_unique").on(table.seriesId, table.position),
]);

export const observations = mysqlTable("observations", {
  id: id(),
  sourceId: foreignId("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  sourceWorkId: varchar("source_work_id", { length: 255 }).notNull(),
  observedAt: datetime("observed_at", { mode: "date", fsp: 3 }).notNull(),
  availability: mysqlEnum("availability", ["public", "restricted", "not_found", "unavailable", "unknown"]).notNull(),
  httpStatus: int("http_status", { unsigned: true }),
  sourceUpdatedAt: date("source_updated_at", { mode: "string" }),
  contentHash: char("content_hash", { length: 71 }),
}, (table) => [
  uniqueIndex("observations_identity_time_unique").on(table.sourceId, table.sourceWorkId, table.observedAt),
  index("observations_work_time").on(table.sourceId, table.sourceWorkId, table.observedAt),
]);

export const fetchSnapshots = mysqlTable("fetch_snapshots", {
  id: id(),
  sourceId: foreignId("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  sourceWorkId: varchar("source_work_id", { length: 255 }),
  url: varchar("url", { length: 1500 }).notNull(),
  urlHash: char("url_hash", { length: 64 }).notNull(),
  httpStatus: int("http_status", { unsigned: true }).notNull(),
  fetchedAt: datetime("fetched_at", { mode: "date", fsp: 3 }).notNull(),
  bodyHash: char("body_hash", { length: 71 }).notNull(),
  storageKey: varchar("storage_key", { length: 1500 }).notNull(),
  responseHeaders: json("response_headers").$type<Record<string, string>>().notNull(),
  parserVersion: varchar("parser_version", { length: 100 }),
}, (table) => [
  index("fetch_snapshots_work_time").on(table.sourceId, table.sourceWorkId, table.fetchedAt),
  uniqueIndex("fetch_snapshots_hash_url_unique").on(table.sourceId, table.urlHash, table.bodyHash),
]);
