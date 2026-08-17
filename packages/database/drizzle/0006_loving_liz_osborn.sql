ALTER TABLE `export_runs` MODIFY COLUMN `status` enum('queued','leased','writing','completed','empty','failed') NOT NULL DEFAULT 'queued';--> statement-breakpoint
ALTER TABLE `export_runs` ADD `maximum_works` int unsigned DEFAULT 500 NOT NULL;--> statement-breakpoint
ALTER TABLE `export_runs` ADD `lease_token` varchar(255);--> statement-breakpoint
ALTER TABLE `export_runs` ADD `lease_expires_at` datetime(3);