ALTER TABLE `export_runs` ADD `sequence_number` bigint unsigned;--> statement-breakpoint
ALTER TABLE `sources` ADD `export_lease_token` varchar(255);--> statement-breakpoint
ALTER TABLE `sources` ADD `export_lease_expires_at` datetime(3);--> statement-breakpoint
ALTER TABLE `sources` ADD `next_export_sequence` bigint unsigned DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `export_runs` ADD CONSTRAINT `export_runs_source_sequence_unique` UNIQUE(`source_id`,`sequence_number`);