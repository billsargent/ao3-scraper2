import { z } from "zod";

export const FORMAT_VERSION = 1 as const;
export const IsoDateTime = z.string().datetime({ offset: true });
export const IsoDate = z.string().date();
export const Sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
export const SourceId = z.string().min(1).max(255);
export const HttpUrl = z.string().url().refine((value) => /^https?:\/\//.test(value), "Expected HTTP(S) URL");

export const ManifestSchema = z.object({
  format: z.literal("ao3-offsite-transfer"),
  formatVersion: z.literal(FORMAT_VERSION),
  packageId: z.string().uuid(),
  packageType: z.enum(["snapshot", "incremental"]),
  source: z.object({
    key: z.string().min(1).max(100),
    origin: HttpUrl,
  }),
  createdAt: IsoDateTime,
  collectorVersion: z.string().min(1),
  previousPackageId: z.string().uuid().nullable(),
  records: z.object({
    authors: z.number().int().nonnegative(),
    workAuthors: z.number().int().nonnegative(),
    works: z.number().int().nonnegative(),
    chapters: z.number().int().nonnegative(),
    tags: z.number().int().nonnegative(),
    workTags: z.number().int().nonnegative(),
    series: z.number().int().nonnegative(),
    seriesWorks: z.number().int().nonnegative(),
    observations: z.number().int().nonnegative(),
    comments: z.number().int().nonnegative().optional(),
    kudos: z.number().int().nonnegative().optional(),
    bookmarks: z.number().int().nonnegative().optional(),
  }),
}).superRefine((manifest, context) => {
  if (manifest.packageType === "snapshot" && manifest.previousPackageId !== null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["previousPackageId"], message: "Snapshot packages cannot have a predecessor" });
  }
  if (manifest.packageType === "incremental" && manifest.previousPackageId === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["previousPackageId"], message: "Incremental packages require a predecessor" });
  }
});

export const AuthorSchema = z.object({
  sourceAuthorId: SourceId,
  name: z.string().min(1).max(255),
  profileUrl: HttpUrl.nullable(),
  anonymous: z.boolean(),
  orphaned: z.boolean(),
});

export const WorkAuthorSchema = z.object({
  sourceWorkId: SourceId,
  sourceAuthorId: SourceId,
  position: z.number().int().positive(),
});

export const WorkSchema = z.object({
  operation: z.enum(["upsert", "hide"]),
  sourceWorkId: SourceId,
  sourceUrl: HttpUrl,
  title: z.string().min(1),
  summaryHtml: z.string(),
  languageCode: z.string().min(1).max(20),
  publishedAt: IsoDate.nullable(),
  updatedAt: IsoDate.nullable(),
  complete: z.boolean(),
  restricted: z.boolean(),
  expectedChapters: z.number().int().positive().nullable(),
  words: z.number().int().nonnegative().nullable(),
  notesHtml: z.string(),
  endNotesHtml: z.string(),
  contentHash: Sha256,
});

export const ChapterSchema = z.object({
  sourceWorkId: SourceId,
  sourceChapterId: SourceId,
  position: z.number().int().positive(),
  title: z.string(),
  summaryHtml: z.string(),
  notesHtml: z.string(),
  contentHtml: z.string().min(1),
  endNotesHtml: z.string(),
  publishedAt: IsoDate.nullable(),
  wordCount: z.number().int().nonnegative().nullable(),
  contentHash: Sha256,
});

export const TagTypeSchema = z.enum([
  "Rating",
  "ArchiveWarning",
  "Category",
  "Fandom",
  "Relationship",
  "Character",
  "Freeform",
]);

export const TagSchema = z.object({
  sourceTagId: SourceId,
  type: TagTypeSchema,
  name: z.string().min(1).max(1000),
  canonical: z.boolean().nullable(),
  sourceUrl: HttpUrl.nullable(),
});

export const WorkTagSchema = z.object({
  sourceWorkId: SourceId,
  sourceTagId: SourceId,
  position: z.number().int().nonnegative(),
});

export const SeriesSchema = z.object({
  sourceSeriesId: SourceId,
  name: z.string().min(1),
  sourceUrl: HttpUrl,
  summaryHtml: z.string(),
  complete: z.boolean().nullable(),
});

export const SeriesWorkSchema = z.object({
  sourceSeriesId: SourceId,
  sourceWorkId: SourceId,
  position: z.number().int().positive(),
});

export const ObservationSchema = z.object({
  sourceWorkId: SourceId,
  observedAt: IsoDateTime,
  availability: z.enum(["public", "restricted", "not_found", "unavailable", "unknown"]),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  sourceUpdatedAt: IsoDate.nullable(),
  contentHash: Sha256.nullable(),
});

export const CommentSchema = z.object({
  operation: z.enum(["upsert", "hide"]),
  sourceWorkId: SourceId,
  sourceCommentId: SourceId,
  parentSourceCommentId: SourceId.nullable(),
  authorName: z.string().min(1).max(255),
  authorProfileUrl: HttpUrl.nullable(),
  postedAt: z.string().min(1).max(255),
  depth: z.number().int().nonnegative(),
  fromWorkCreator: z.boolean(),
  textHtml: z.string(),
  contentHash: Sha256,
});

export const KudoSchema = z.object({
  sourceWorkId: SourceId,
  sourceKudoId: SourceId,
  authorName: z.string().min(1).max(255),
  authorProfileUrl: HttpUrl.nullable(),
  observedAt: IsoDateTime,
});

export const BookmarkSchema = z.object({
  operation: z.enum(["upsert", "hide"]),
  sourceBookmarkId: SourceId,
  sourceWorkId: SourceId,
  bookmarkerName: z.string().min(1).max(255),
  bookmarkerProfileUrl: HttpUrl.nullable(),
  notesHtml: z.string(),
  tags: z.array(z.object({ name: z.string().min(1).max(1000) })),
  updatedAt: z.string().min(1).max(255),
  contentHash: Sha256,
});

export const RecordSchemas = {
  "authors.jsonl": AuthorSchema,
  "work-authors.jsonl": WorkAuthorSchema,
  "works.jsonl": WorkSchema,
  "chapters.jsonl": ChapterSchema,
  "tags.jsonl": TagSchema,
  "work-tags.jsonl": WorkTagSchema,
  "series.jsonl": SeriesSchema,
  "series-works.jsonl": SeriesWorkSchema,
  "observations.jsonl": ObservationSchema,
  "comments.jsonl": CommentSchema,
  "kudos.jsonl": KudoSchema,
  "bookmarks.jsonl": BookmarkSchema,
} as const;

export type Manifest = z.infer<typeof ManifestSchema>;
export type Author = z.infer<typeof AuthorSchema>;
export type WorkAuthor = z.infer<typeof WorkAuthorSchema>;
export type Work = z.infer<typeof WorkSchema>;
export type Chapter = z.infer<typeof ChapterSchema>;
export type Tag = z.infer<typeof TagSchema>;
export type WorkTag = z.infer<typeof WorkTagSchema>;
export type Series = z.infer<typeof SeriesSchema>;
export type SeriesWork = z.infer<typeof SeriesWorkSchema>;
export type Observation = z.infer<typeof ObservationSchema>;
export type Comment = z.infer<typeof CommentSchema>;
export type Kudo = z.infer<typeof KudoSchema>;
export type Bookmark = z.infer<typeof BookmarkSchema>;

export interface TransferRecords {
  authors: Author[];
  workAuthors: WorkAuthor[];
  works: Work[];
  chapters: Chapter[];
  tags: Tag[];
  workTags: WorkTag[];
  series: Series[];
  seriesWorks: SeriesWork[];
  observations: Observation[];
  comments: Comment[];
  kudos: Kudo[];
  bookmarks: Bookmark[];
}

export interface TransferPackage {
  manifest: Manifest;
  records: TransferRecords;
}
