ALTER TABLE `fetch_snapshots` MODIFY `body_hash` char(71);--> statement-breakpoint
ALTER TABLE `fetch_snapshots` MODIFY `storage_key` varchar(1500);--> statement-breakpoint
ALTER TABLE `fetch_snapshots` ADD `attempts` int unsigned NOT NULL DEFAULT 1;
