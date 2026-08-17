CREATE TABLE `authors` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source_id` bigint unsigned NOT NULL,
	`source_author_id` varchar(255) NOT NULL,
	`name` varchar(255) NOT NULL,
	`profile_url` varchar(1000),
	`anonymous` boolean NOT NULL DEFAULT false,
	`orphaned` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `authors_id` PRIMARY KEY(`id`),
	CONSTRAINT `authors_source_identity_unique` UNIQUE(`source_id`,`source_author_id`)
);
--> statement-breakpoint
CREATE TABLE `chapters` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`work_id` bigint unsigned NOT NULL,
	`source_chapter_id` varchar(255) NOT NULL,
	`position` int unsigned NOT NULL,
	`title` text NOT NULL,
	`summary_html` longtext NOT NULL,
	`notes_html` longtext NOT NULL,
	`content_html` longtext NOT NULL,
	`end_notes_html` longtext NOT NULL,
	`published_at` date,
	`word_count` int unsigned,
	`content_hash` char(71) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `chapters_id` PRIMARY KEY(`id`),
	CONSTRAINT `chapters_work_source_unique` UNIQUE(`work_id`,`source_chapter_id`),
	CONSTRAINT `chapters_work_position_unique` UNIQUE(`work_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `collection_jobs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source_id` bigint unsigned NOT NULL,
	`job_type` enum('id_range','explicit_ids','refresh') NOT NULL,
	`status` enum('queued','running','paused','completed','failed','cancelled') NOT NULL DEFAULT 'queued',
	`configuration` json NOT NULL,
	`discovered_count` int unsigned NOT NULL DEFAULT 0,
	`succeeded_count` int unsigned NOT NULL DEFAULT 0,
	`failed_count` int unsigned NOT NULL DEFAULT 0,
	`skipped_count` int unsigned NOT NULL DEFAULT 0,
	`started_at` datetime(3),
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `collection_jobs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `collection_tasks` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`job_id` bigint unsigned NOT NULL,
	`source_work_id` varchar(255) NOT NULL,
	`status` enum('queued','leased','succeeded','retryable_failed','terminal_failed','cancelled') NOT NULL DEFAULT 'queued',
	`attempts` int unsigned NOT NULL DEFAULT 0,
	`available_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`lease_expires_at` datetime(3),
	`last_error_code` varchar(100),
	`last_error_message` text,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `collection_tasks_id` PRIMARY KEY(`id`),
	CONSTRAINT `collection_tasks_job_work_unique` UNIQUE(`job_id`,`source_work_id`)
);
--> statement-breakpoint
CREATE TABLE `fetch_snapshots` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source_id` bigint unsigned NOT NULL,
	`source_work_id` varchar(255),
	`url` varchar(1500) NOT NULL,
	`url_hash` char(64) NOT NULL,
	`http_status` int unsigned NOT NULL,
	`fetched_at` datetime(3) NOT NULL,
	`body_hash` char(71) NOT NULL,
	`storage_key` varchar(1500) NOT NULL,
	`response_headers` json NOT NULL,
	`parser_version` varchar(100),
	CONSTRAINT `fetch_snapshots_id` PRIMARY KEY(`id`),
	CONSTRAINT `fetch_snapshots_hash_url_unique` UNIQUE(`source_id`,`url_hash`,`body_hash`)
);
--> statement-breakpoint
CREATE TABLE `observations` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source_id` bigint unsigned NOT NULL,
	`source_work_id` varchar(255) NOT NULL,
	`observed_at` datetime(3) NOT NULL,
	`availability` enum('public','restricted','not_found','unavailable','unknown') NOT NULL,
	`http_status` int unsigned,
	`source_updated_at` date,
	`content_hash` char(71),
	CONSTRAINT `observations_id` PRIMARY KEY(`id`),
	CONSTRAINT `observations_identity_time_unique` UNIQUE(`source_id`,`source_work_id`,`observed_at`)
);
--> statement-breakpoint
CREATE TABLE `series` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source_id` bigint unsigned NOT NULL,
	`source_series_id` varchar(255) NOT NULL,
	`source_url` varchar(1000) NOT NULL,
	`name` text NOT NULL,
	`summary_html` longtext NOT NULL,
	`complete` boolean,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `series_id` PRIMARY KEY(`id`),
	CONSTRAINT `series_source_identity_unique` UNIQUE(`source_id`,`source_series_id`)
);
--> statement-breakpoint
CREATE TABLE `series_works` (
	`series_id` bigint unsigned NOT NULL,
	`work_id` bigint unsigned NOT NULL,
	`position` int unsigned NOT NULL,
	CONSTRAINT `series_works_series_id_work_id_pk` PRIMARY KEY(`series_id`,`work_id`),
	CONSTRAINT `series_works_position_unique` UNIQUE(`series_id`,`position`)
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source_key` varchar(100) NOT NULL,
	`origin` varchar(500) NOT NULL,
	`minimum_delay_ms` int unsigned NOT NULL DEFAULT 5000,
	`daily_request_budget` int unsigned,
	`paused` boolean NOT NULL DEFAULT false,
	`next_request_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `sources_id` PRIMARY KEY(`id`),
	CONSTRAINT `sources_key_unique` UNIQUE(`source_key`)
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source_id` bigint unsigned NOT NULL,
	`source_tag_id` varchar(255) NOT NULL,
	`tag_type` enum('Rating','ArchiveWarning','Category','Fandom','Relationship','Character','Freeform') NOT NULL,
	`name` text NOT NULL,
	`canonical` boolean,
	`source_url` varchar(1000),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tags_id` PRIMARY KEY(`id`),
	CONSTRAINT `tags_source_identity_unique` UNIQUE(`source_id`,`source_tag_id`)
);
--> statement-breakpoint
CREATE TABLE `work_authors` (
	`work_id` bigint unsigned NOT NULL,
	`author_id` bigint unsigned NOT NULL,
	`position` int unsigned NOT NULL,
	CONSTRAINT `work_authors_work_id_author_id_pk` PRIMARY KEY(`work_id`,`author_id`)
);
--> statement-breakpoint
CREATE TABLE `work_tags` (
	`work_id` bigint unsigned NOT NULL,
	`tag_id` bigint unsigned NOT NULL,
	`position` int unsigned NOT NULL,
	CONSTRAINT `work_tags_work_id_tag_id_pk` PRIMARY KEY(`work_id`,`tag_id`)
);
--> statement-breakpoint
CREATE TABLE `works` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source_id` bigint unsigned NOT NULL,
	`source_work_id` varchar(255) NOT NULL,
	`source_url` varchar(1000) NOT NULL,
	`title` text NOT NULL,
	`summary_html` longtext NOT NULL,
	`notes_html` longtext NOT NULL,
	`end_notes_html` longtext NOT NULL,
	`language_code` varchar(20) NOT NULL,
	`published_at` date,
	`source_updated_at` date,
	`complete` boolean NOT NULL,
	`restricted` boolean NOT NULL,
	`expected_chapters` int unsigned,
	`words` bigint unsigned,
	`content_hash` char(71) NOT NULL,
	`availability` enum('public','restricted','not_found','unavailable','unknown') NOT NULL DEFAULT 'public',
	`first_seen_at` datetime(3) NOT NULL,
	`last_seen_at` datetime(3) NOT NULL,
	`last_successful_capture_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `works_id` PRIMARY KEY(`id`),
	CONSTRAINT `works_source_identity_unique` UNIQUE(`source_id`,`source_work_id`)
);
--> statement-breakpoint
ALTER TABLE `authors` ADD CONSTRAINT `authors_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `chapters` ADD CONSTRAINT `chapters_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `collection_jobs` ADD CONSTRAINT `collection_jobs_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `collection_tasks` ADD CONSTRAINT `collection_tasks_job_id_collection_jobs_id_fk` FOREIGN KEY (`job_id`) REFERENCES `collection_jobs`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fetch_snapshots` ADD CONSTRAINT `fetch_snapshots_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `observations` ADD CONSTRAINT `observations_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `series` ADD CONSTRAINT `series_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `series_works` ADD CONSTRAINT `series_works_series_id_series_id_fk` FOREIGN KEY (`series_id`) REFERENCES `series`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `series_works` ADD CONSTRAINT `series_works_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `tags` ADD CONSTRAINT `tags_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `work_authors` ADD CONSTRAINT `work_authors_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `work_authors` ADD CONSTRAINT `work_authors_author_id_authors_id_fk` FOREIGN KEY (`author_id`) REFERENCES `authors`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `work_tags` ADD CONSTRAINT `work_tags_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `work_tags` ADD CONSTRAINT `work_tags_tag_id_tags_id_fk` FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `works` ADD CONSTRAINT `works_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `collection_jobs_source_status` ON `collection_jobs` (`source_id`,`status`);--> statement-breakpoint
CREATE INDEX `collection_tasks_claim` ON `collection_tasks` (`status`,`available_at`,`lease_expires_at`);--> statement-breakpoint
CREATE INDEX `fetch_snapshots_work_time` ON `fetch_snapshots` (`source_id`,`source_work_id`,`fetched_at`);--> statement-breakpoint
CREATE INDEX `observations_work_time` ON `observations` (`source_id`,`source_work_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `work_authors_order` ON `work_authors` (`work_id`,`position`);--> statement-breakpoint
CREATE INDEX `work_tags_order` ON `work_tags` (`work_id`,`position`);--> statement-breakpoint
CREATE INDEX `works_refresh` ON `works` (`availability`,`source_updated_at`,`last_seen_at`);