CREATE TABLE `auto_fill` (
	`source_id` bigint unsigned NOT NULL,
	`enabled` boolean NOT NULL DEFAULT false,
	`frontier_start` bigint unsigned NOT NULL DEFAULT 1,
	`batch_size` int unsigned NOT NULL DEFAULT 200,
	`last_job_id` bigint unsigned,
	`last_run_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `auto_fill_source_id_pk` PRIMARY KEY(`source_id`)
);
--> statement-breakpoint
ALTER TABLE `auto_fill` ADD CONSTRAINT `auto_fill_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE cascade ON UPDATE no action;