ALTER TABLE `sources` MODIFY COLUMN `minimum_delay_ms` int unsigned NOT NULL DEFAULT 10000;--> statement-breakpoint
ALTER TABLE `sources` MODIFY COLUMN `daily_request_budget` int unsigned DEFAULT 250;