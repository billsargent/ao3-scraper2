CREATE TABLE `export_runs` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`source_id` bigint unsigned NOT NULL,
	`package_id` char(36) NOT NULL,
	`previous_package_id` char(36),
	`status` enum('writing','completed','failed') NOT NULL DEFAULT 'writing',
	`output_directory` varchar(1500) NOT NULL,
	`work_count` int unsigned NOT NULL DEFAULT 0,
	`error_message` text,
	`completed_at` datetime(3),
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	`updated_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `export_runs_id` PRIMARY KEY(`id`),
	CONSTRAINT `export_runs_package_unique` UNIQUE(`package_id`)
);
--> statement-breakpoint
ALTER TABLE `works` ADD `last_exported_hash` char(71);--> statement-breakpoint
ALTER TABLE `works` ADD `last_exported_at` datetime(3);--> statement-breakpoint
ALTER TABLE `works` ADD `last_export_package_id` char(36);--> statement-breakpoint
ALTER TABLE `export_runs` ADD CONSTRAINT `export_runs_source_id_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `export_runs_source_status` ON `export_runs` (`source_id`,`status`,`completed_at`);