ALTER TABLE `sources` ADD `capture_comments` boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE `sources` ADD `capture_kudos` boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE `sources` ADD `capture_bookmarks` boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE `sources` ADD `maximum_comment_pages` int unsigned;--> statement-breakpoint
ALTER TABLE `sources` ADD `maximum_kudos_pages` int unsigned;--> statement-breakpoint
ALTER TABLE `sources` ADD `maximum_bookmark_pages` int unsigned;--> statement-breakpoint
CREATE TABLE `comments` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source_id` bigint unsigned NOT NULL,
	`work_id` bigint unsigned NOT NULL,
	`source_comment_id` varchar(255) NOT NULL,
	`parent_source_comment_id` varchar(255),
	`author_name` varchar(255) NOT NULL,
	`author_profile_url` varchar(1000),
	`posted_at` varchar(255) NOT NULL,
	`depth` int unsigned NOT NULL DEFAULT 0,
	`from_work_creator` boolean NOT NULL DEFAULT false,
	`text_html` longtext NOT NULL,
	`content_hash` char(71) NOT NULL,
	`hidden` boolean NOT NULL DEFAULT false,
	`first_seen_at` datetime(3) NOT NULL,
	`last_seen_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `comments_id` PRIMARY KEY(`id`),
	CONSTRAINT `comments_work_source_unique` UNIQUE(`work_id`,`source_comment_id`)
);
--> statement-breakpoint
CREATE TABLE `kudos` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source_id` bigint unsigned NOT NULL,
	`work_id` bigint unsigned NOT NULL,
	`source_kudo_id` varchar(255) NOT NULL,
	`author_name` varchar(255) NOT NULL,
	`author_profile_url` varchar(1000),
	`observed_at` datetime(3) NOT NULL,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `kudos_id` PRIMARY KEY(`id`),
	CONSTRAINT `kudos_work_source_unique` UNIQUE(`work_id`,`source_kudo_id`)
);
--> statement-breakpoint
CREATE TABLE `bookmarks` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source_id` bigint unsigned NOT NULL,
	`work_id` bigint unsigned NOT NULL,
	`source_bookmark_id` varchar(255) NOT NULL,
	`bookmarker_name` varchar(255) NOT NULL,
	`bookmarker_profile_url` varchar(1000),
	`notes_html` longtext NOT NULL,
	`tags_json` json NOT NULL,
	`source_updated_at` varchar(255) NOT NULL,
	`content_hash` char(71) NOT NULL,
	`hidden` boolean NOT NULL DEFAULT false,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `bookmarks_id` PRIMARY KEY(`id`),
	CONSTRAINT `bookmarks_work_source_unique` UNIQUE(`work_id`,`source_bookmark_id`)
);
--> statement-breakpoint
ALTER TABLE `comments` ADD CONSTRAINT `comments_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `comments` ADD CONSTRAINT `comments_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `kudos` ADD CONSTRAINT `kudos_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `kudos` ADD CONSTRAINT `kudos_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookmarks` ADD CONSTRAINT `bookmarks_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `bookmarks` ADD CONSTRAINT `bookmarks_work_id_works_id_fk` FOREIGN KEY (`work_id`) REFERENCES `works`(`id`) ON DELETE cascade ON UPDATE no action;
