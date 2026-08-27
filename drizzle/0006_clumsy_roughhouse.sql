CREATE TABLE `transcodes` (
	`id` text PRIMARY KEY NOT NULL,
	`source_path` text NOT NULL,
	`output_path` text NOT NULL,
	`preset` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`progress` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 2 NOT NULL,
	`not_before` text,
	`replace_original` integer DEFAULT false NOT NULL,
	`duration_seconds` integer,
	`source_bytes` integer,
	`output_bytes` integer,
	`error` text,
	`log` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `transcodes_claim_idx` ON `transcodes` (`status`,`not_before`,`created_at`);--> statement-breakpoint
CREATE INDEX `transcodes_source_idx` ON `transcodes` (`source_path`);