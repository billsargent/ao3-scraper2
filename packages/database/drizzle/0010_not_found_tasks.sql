ALTER TABLE `collection_tasks` MODIFY `status` enum('queued','leased','succeeded','retryable_failed','terminal_failed','cancelled','not_found') NOT NULL DEFAULT 'queued';
