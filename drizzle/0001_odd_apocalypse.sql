DROP INDEX `jobs_claim_idx`;--> statement-breakpoint
ALTER TABLE `jobs` ADD `not_before` text;--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`paused`,`not_before`,`priority`,`created_at`);