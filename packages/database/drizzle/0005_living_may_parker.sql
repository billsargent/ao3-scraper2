ALTER TABLE `sources` ADD `user_agent` varchar(1000) DEFAULT 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `include_adult` boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `daily_byte_budget` bigint unsigned DEFAULT 1073741824;--> statement-breakpoint
ALTER TABLE `sources` ADD `request_timeout_ms` int unsigned DEFAULT 60000 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `maximum_response_bytes` bigint unsigned DEFAULT 20971520 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `maximum_failure_attempts` int unsigned DEFAULT 6 NOT NULL;--> statement-breakpoint
ALTER TABLE `sources` ADD `operating_window_start_hour_utc` int unsigned;--> statement-breakpoint
ALTER TABLE `sources` ADD `operating_window_end_hour_utc` int unsigned;