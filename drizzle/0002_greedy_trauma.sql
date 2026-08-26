PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`provider` text,
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
	`not_before` text,
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
INSERT INTO `__new_jobs`("id", "url", "provider", "destination", "title", "status", "stages", "priority", "attempts", "max_attempts", "paused", "claimed_by", "lease_until", "not_before", "progress", "total_bytes", "done_bytes", "speed", "eta", "thumbnail", "duration", "source", "preferences", "fingerprint", "log", "error", "output_file", "created_at", "updated_at") SELECT "id", "url", "provider", "destination", "title", "status", "stages", "priority", "attempts", "max_attempts", "paused", "claimed_by", "lease_until", "not_before", "progress", "total_bytes", "done_bytes", "speed", "eta", "thumbnail", "duration", "source", "preferences", "fingerprint", "log", "error", "output_file", "created_at", "updated_at" FROM `jobs`;--> statement-breakpoint
DROP TABLE `jobs`;--> statement-breakpoint
ALTER TABLE `__new_jobs` RENAME TO `jobs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `jobs` (`status`,`paused`,`not_before`,`priority`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_fingerprint_idx` ON `jobs` (`fingerprint`);--> statement-breakpoint
CREATE INDEX `jobs_lease_idx` ON `jobs` (`lease_until`);