ALTER TABLE `export_runs` ADD `archive_path` varchar(1500);--> statement-breakpoint
ALTER TABLE `export_runs` ADD `archive_hash` char(71);--> statement-breakpoint
ALTER TABLE `export_runs` ADD `archive_bytes` bigint unsigned;--> statement-breakpoint
ALTER TABLE `export_runs` ADD `verified_at` datetime(3);--> statement-breakpoint
ALTER TABLE `export_runs` ADD `import_status` enum('not_imported','importing','imported','failed') DEFAULT 'not_imported' NOT NULL;--> statement-breakpoint
ALTER TABLE `export_runs` ADD `import_started_at` datetime(3);--> statement-breakpoint
ALTER TABLE `export_runs` ADD `imported_at` datetime(3);--> statement-breakpoint
ALTER TABLE `export_runs` ADD `import_error` text;--> statement-breakpoint
ALTER TABLE `export_runs` ADD `otw_import_run_id` varchar(255);