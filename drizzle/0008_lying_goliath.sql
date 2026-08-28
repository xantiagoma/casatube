ALTER TABLE `jobs` ADD `output_name` text;--> statement-breakpoint
ALTER TABLE `jobs` ADD `on_conflict` text DEFAULT 'suffix' NOT NULL;