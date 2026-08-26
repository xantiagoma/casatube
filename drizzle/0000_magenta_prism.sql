CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`provider` text NOT NULL,
	`destination` text NOT NULL,
	`title` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`stages` text DEFAULT '[]' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`claimed_by` text,
	`lease_until` text,
	`progress` integer DEFAULT 0 NOT NULL,
	`total_bytes` integer,
	`done_bytes` integer,
	`speed` integer,
	`eta` integer,
	`thumbnail` text,
	`duration` integer,
	`source` text,
	`preferences` text NOT NULL,
	`fingerprint` text NOT NULL,
	`log` text DEFAULT '[]' NOT NULL,
	`error` text,
	`output_file` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`paused`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_fingerprint_idx` ON `jobs` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `jobs_lease_idx` ON `jobs` (`lease_until`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`level` text DEFAULT 'info' NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`job_id` text,
	`read_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `notifications_unread_idx` ON `notifications` (`read_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_seen` (
	`source_id` text NOT NULL,
	`external_id` text NOT NULL,
	`seen_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `source_seen_idx` ON `source_seen` (`source_id`,`external_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`name` text NOT NULL,
	`destination` text NOT NULL,
	`preferences` text NOT NULL,
	`interval_minutes` integer DEFAULT 360 NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_checked_at` text,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sources_due_idx` ON `sources` (`enabled`,`last_checked_at`);