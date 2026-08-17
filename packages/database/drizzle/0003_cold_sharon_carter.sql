CREATE TABLE `source_daily_usage` (
	`source_id` bigint unsigned NOT NULL,
	`usage_date` date NOT NULL,
	`request_count` int unsigned NOT NULL DEFAULT 0,
	`response_bytes` bigint unsigned NOT NULL DEFAULT 0,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `source_daily_usage_source_id_usage_date_pk` PRIMARY KEY(`source_id`,`usage_date`)
);
--> statement-breakpoint
ALTER TABLE `source_daily_usage` ADD CONSTRAINT `source_daily_usage_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE cascade ON UPDATE no action;