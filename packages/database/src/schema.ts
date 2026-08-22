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

export const STANDARD_CHROME_USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

export const sources = mysqlTable("sources", {
  id: id(),
  key: varchar("source_key", { length: 100 }).notNull(),
  origin: varchar("origin", { length: 500 }).notNull(),
  userAgent: varchar("user_agent", { length: 1000 }).notNull().default(STANDARD_CHROME_USER_AGENT),
  includeAdult: boolean("include_adult").notNull().default(true),
  minimumDelayMs: int("minimum_delay_ms", { unsigned: true }).notNull().default(10000),
  dailyRequestBudget: int("daily_request_budget", { unsigned: true }).default(250),
  dailyByteBudget: bigint("daily_byte_budget", { mode: "number", unsigned: true }).default(1073741824),
  requestTimeoutMs: int("request_timeout_ms", { unsigned: true }).notNull().default(60000),
  maximumResponseBytes: bigint("maximum_response_bytes", { mode: "number", unsigned: true }).notNull().default(20971520),
  maximumFailureAttempts: int("maximum_failure_attempts", { unsigned: true }).notNull().default(6),
  operatingWindowStartHourUtc: int("operating_window_start_hour_utc", { unsigned: true }),
  operatingWindowEndHourUtc: int("operating_window_end_hour_utc", { unsigned: true }),
  exportLeaseToken: varchar("export_lease_token", { length: 255 }),
  exportLeaseExpiresAt: datetime("export_lease_expires_at", { mode: "date", fsp: 3 }),
  nextExportSequence: bigint("next_export_sequence", { mode: "number", unsigned: true }).notNull().default(1),
  paused: boolean("paused").notNull().default(false),
  nextRequestAt: datetime("next_request_at", { mode: "date", fsp: 3 }),
  captureComments: boolean("capture_comments").notNull().default(false),
  captureKudos: boolean("capture_kudos").notNull().default(false),
  captureBookmarks: boolean("capture_bookmarks").notNull().default(false),
  maximumCommentPages: int("maximum_comment_pages", { unsigned: true }),
  maximumKudosPages: int("maximum_kudos_pages", { unsigned: true }),
  maximumBookmarkPages: int("maximum_bookmark_pages", { unsigned: true }),
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
  planningStatus: mysqlEnum("planning_status", ["queued", "leased", "planning", "completed", "failed"]).notNull().default("queued"),
  planningCursor: bigint("planning_cursor", { mode: "number", unsigned: true }),
  planningLeaseToken: varchar("planning_lease_token", { length: 255 }),
  planningLeaseExpiresAt: datetime("planning_lease_expires_at", { mode: "date", fsp: 3 }),
  planningError: text("planning_error"),
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
  sequenceNumber: bigint("sequence_number", { mode: "number", unsigned: true }),
  status: mysqlEnum("status", ["queued", "leased", "writing", "completed", "empty", "failed"]).notNull().default("queued"),
  outputDirectory: varchar("output_directory", { length: 1500 }).notNull(),
  maximumWorks: int("maximum_works", { unsigned: true }).notNull().default(500),
  workCount: int("work_count", { unsigned: true }).notNull().default(0),
  leaseToken: varchar("lease_token", { length: 255 }),
  leaseExpiresAt: datetime("lease_expires_at", { mode: "date", fsp: 3 }),
  errorMessage: text("error_message"),
  archivePath: varchar("archive_path", { length: 1500 }),
  archiveHash: char("archive_hash", { length: 71 }),
  archiveBytes: bigint("archive_bytes", { mode: "number", unsigned: true }),
  verifiedAt: datetime("verified_at", { mode: "date", fsp: 3 }),
  importStatus: mysqlEnum("import_status", ["not_imported", "importing", "imported", "failed"]).notNull().default("not_imported"),
  importStartedAt: datetime("import_started_at", { mode: "date", fsp: 3 }),
  importedAt: datetime("imported_at", { mode: "date", fsp: 3 }),
  importError: text("import_error"),
  otwImportRunId: varchar("otw_import_run_id", { length: 255 }),
  completedAt: datetime("completed_at", { mode: "date", fsp: 3 }),
  ...timestamps,
}, (table) => [
  uniqueIndex("export_runs_package_unique").on(table.packageId),
  uniqueIndex("export_runs_source_sequence_unique").on(table.sourceId, table.sequenceNumber),
  index("export_runs_source_status").on(table.sourceId, table.status, table.completedAt),
]);

export const collectionTasks = mysqlTable("collection_tasks", {
  id: id(),
  jobId: foreignId("job_id").notNull().references(() => collectionJobs.id, { onDelete: "cascade" }),
  sourceWorkId: varchar("source_work_id", { length: 255 }).notNull(),
  status: mysqlEnum("status", ["queued", "leased", "succeeded", "retryable_failed", "terminal_failed", "cancelled", "not_found"]).notNull().default("queued"),
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
  bodyHash: char("body_hash", { length: 71 }),
  storageKey: varchar("storage_key", { length: 1500 }),
  responseHeaders: json("response_headers").$type<Record<string, string>>().notNull(),
  parserVersion: varchar("parser_version", { length: 100 }),
  attempts: int("attempts", { unsigned: true }).notNull().default(1),
}, (table) => [
  index("fetch_snapshots_work_time").on(table.sourceId, table.sourceWorkId, table.fetchedAt),
  uniqueIndex("fetch_snapshots_hash_url_unique").on(table.sourceId, table.urlHash, table.bodyHash),
]);

export const comments = mysqlTable("comments", {
  id: id(),
  sourceId: foreignId("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  workId: foreignId("work_id").notNull().references(() => works.id, { onDelete: "cascade" }),
  sourceCommentId: varchar("source_comment_id", { length: 255 }).notNull(),
  parentSourceCommentId: varchar("parent_source_comment_id", { length: 255 }),
  authorName: varchar("author_name", { length: 255 }).notNull(),
  authorProfileUrl: varchar("author_profile_url", { length: 1000 }),
  postedAt: varchar("posted_at", { length: 255 }).notNull(),
  depth: int("depth", { unsigned: true }).notNull().default(0),
  fromWorkCreator: boolean("from_work_creator").notNull().default(false),
  textHtml: longtext("text_html").notNull(),
  contentHash: char("content_hash", { length: 71 }).notNull(),
  hidden: boolean("hidden").notNull().default(false),
  firstSeenAt: datetime("first_seen_at", { mode: "date", fsp: 3 }).notNull(),
  lastSeenAt: datetime("last_seen_at", { mode: "date", fsp: 3 }).notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("comments_work_source_unique").on(table.workId, table.sourceCommentId),
  index("comments_work_posted").on(table.workId, table.postedAt),
]);

export const kudos = mysqlTable("kudos", {
  id: id(),
  sourceId: foreignId("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  workId: foreignId("work_id").notNull().references(() => works.id, { onDelete: "cascade" }),
  sourceKudoId: varchar("source_kudo_id", { length: 255 }).notNull(),
  authorName: varchar("author_name", { length: 255 }).notNull(),
  authorProfileUrl: varchar("author_profile_url", { length: 1000 }),
  observedAt: datetime("observed_at", { mode: "date", fsp: 3 }).notNull(),
  ...timestamps,
}, (table) => [
  uniqueIndex("kudos_work_source_unique").on(table.workId, table.sourceKudoId),
]);

export const bookmarks = mysqlTable("bookmarks", {
  id: id(),
  sourceId: foreignId("source_id").notNull().references(() => sources.id, { onDelete: "restrict" }),
  workId: foreignId("work_id").notNull().references(() => works.id, { onDelete: "cascade" }),
  sourceBookmarkId: varchar("source_bookmark_id", { length: 255 }).notNull(),
  bookmarkerName: varchar("bookmarker_name", { length: 255 }).notNull(),
  bookmarkerProfileUrl: varchar("bookmarker_profile_url", { length: 1000 }),
  notesHtml: longtext("notes_html").notNull(),
  tagsJson: json("tags_json").$type<Array<{ name: string }>>().notNull(),
  sourceUpdatedAt: varchar("source_updated_at", { length: 255 }).notNull(),
  contentHash: char("content_hash", { length: 71 }).notNull(),
  hidden: boolean("hidden").notNull().default(false),
  ...timestamps,
}, (table) => [
  uniqueIndex("bookmarks_work_source_unique").on(table.workId, table.sourceBookmarkId),
]);

export const workerEvents = mysqlTable("worker_events", {
  id: id(),
  service: mysqlEnum("service", ["api", "collector", "planner", "export", "system"]).notNull(),
  workerId: varchar("worker_id", { length: 255 }),
  level: mysqlEnum("level", ["debug", "info", "warn", "error"]).notNull().default("info"),
  event: varchar("event", { length: 255 }).notNull(),
  message: text("message"),
  context: json("context").$type<Record<string, unknown>>(),
  createdAt: datetime("created_at", { mode: "date", fsp: 3 }).notNull().default(sql`CURRENT_TIMESTAMP(3)`),
}, (table) => [
  index("worker_events_service_time").on(table.service, table.createdAt),
  index("worker_events_created").on(table.createdAt),
]);

export const autoFill = mysqlTable("auto_fill", {
  sourceId: foreignId("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  frontierStart: bigint("frontier_start", { mode: "number", unsigned: true }).notNull().default(1),
  batchSize: int("batch_size", { unsigned: true }).notNull().default(200),
  lastJobId: bigint("last_job_id", { mode: "number", unsigned: true }),
  lastRunAt: datetime("last_run_at", { mode: "date", fsp: 3 }),
  ...timestamps,
}, (table) => [primaryKey({ columns: [table.sourceId] })]);

export const tagSubscriptions = mysqlTable("tag_subscriptions", {
  id: id(),
  sourceId: foreignId("source_id").notNull().references(() => sources.id, { onDelete: "cascade" }),
  tagName: varchar("tag_name", { length: 255 }).notNull(),
  tagSlug: varchar("tag_slug", { length: 500 }).notNull(),
  tagType: mysqlEnum("tag_type", ["Rating", "ArchiveWarning", "Category", "Fandom", "Relationship", "Character", "Freeform"]).notNull().default("Freeform"),
  nextPage: int("next_page", { unsigned: true }).notNull().default(1),
  lastJobId: bigint("last_job_id", { mode: "number", unsigned: true }),
  lastRunAt: datetime("last_run_at", { mode: "date", fsp: 3 }),
  enabled: boolean("enabled").notNull().default(true),
  ...timestamps,
}, (table) => [
  uniqueIndex("tag_subscriptions_source_slug_unique").on(table.sourceId, table.tagSlug),
]);
