CREATE TABLE `worker_events` (
	`id` bigint unsigned AUTO_INCREMENT NOT NULL,
	`service` enum('api','collector','planner','export','system') NOT NULL,
	`worker_id` varchar(255),
	`level` enum('debug','info','warn','error') NOT NULL DEFAULT 'info',
	`event` varchar(255) NOT NULL,
	`message` text,
	`context` json,
	`created_at` datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
	CONSTRAINT `worker_events_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `worker_events_service_time` ON `worker_events` (`service`,`created_at`);
--> statement-breakpoint
CREATE INDEX `worker_events_created` ON `worker_events` (`created_at`);