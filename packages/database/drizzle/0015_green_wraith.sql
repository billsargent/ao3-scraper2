CREATE TABLE `tag_subscriptions` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source_id` bigint unsigned NOT NULL,
	`tag_name` varchar(255) NOT NULL,
	`tag_slug` varchar(500) NOT NULL,
	`tag_type` enum('Rating','ArchiveWarning','Category','Fandom','Relationship','Character','Freeform') NOT NULL DEFAULT 'Freeform',
	`next_page` int unsigned NOT NULL DEFAULT 1,
	`last_job_id` bigint unsigned,
	`last_run_at` datetime(3),
	`enabled` boolean NOT NULL DEFAULT true,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `tag_subscriptions_id` PRIMARY KEY(`id`),
	CONSTRAINT `tag_subscriptions_source_slug_unique` UNIQUE(`source_id`,`tag_slug`)
);
--> statement-breakpoint
ALTER TABLE `tag_subscriptions` ADD CONSTRAINT `tag_subscriptions_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE cascade ON UPDATE no action;