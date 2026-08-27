CREATE TABLE `credentials` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`type` text NOT NULL,
	`label` text,
	`secret` text NOT NULL,
	`protection` text DEFAULT 'plaintext' NOT NULL,
	`key_id` text,
	`meta` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`updated_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `credentials_scope_type_idx` ON `credentials` (`scope`,`type`);--> statement-breakpoint
CREATE INDEX `credentials_scope_idx` ON `credentials` (`scope`);