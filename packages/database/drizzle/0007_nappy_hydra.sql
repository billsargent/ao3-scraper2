ALTER TABLE `collection_jobs` ADD `planning_status` enum('queued','leased','planning','completed','failed') DEFAULT 'queued' NOT NULL;--> statement-breakpoint
ALTER TABLE `collection_jobs` ADD `planning_cursor` bigint unsigned;--> statement-breakpoint
ALTER TABLE `collection_jobs` ADD `planning_lease_token` varchar(255);--> statement-breakpoint
ALTER TABLE `collection_jobs` ADD `planning_lease_expires_at` datetime(3);--> statement-breakpoint
ALTER TABLE `collection_jobs` ADD `planning_error` text;