CREATE TABLE `presentation_image` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`owner_token_id` text,
	`source_type` text NOT NULL,
	`source_ref` text DEFAULT '' NOT NULL,
	`file_name` text DEFAULT '' NOT NULL,
	`tags` text DEFAULT '' NOT NULL,
	`width` integer,
	`height` integer,
	`file_size` integer DEFAULT 0 NOT NULL,
	`storage_key` text DEFAULT '' NOT NULL,
	`storage_url` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`last_used_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_presentation_image_owner` ON `presentation_image` (`owner_user_id`);--> statement-breakpoint
CREATE INDEX `idx_presentation_image_source` ON `presentation_image` (`source_type`);--> statement-breakpoint
CREATE TABLE `presentation_outline` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`owner_token_id` text,
	`source_ids` text DEFAULT '[]' NOT NULL,
	`pages` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_presentation_outline_owner` ON `presentation_outline` (`owner_user_id`);--> statement-breakpoint
CREATE TABLE `presentation_source` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_user_id` text NOT NULL,
	`owner_token_id` text,
	`kind` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'ready' NOT NULL,
	`extract_chars` integer DEFAULT 0 NOT NULL,
	`page_count` integer,
	`text` text DEFAULT '' NOT NULL,
	`meta` text,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_presentation_source_owner` ON `presentation_source` (`owner_user_id`);--> statement-breakpoint
ALTER TABLE `presentation_job` ADD `image_assignments` text;--> statement-breakpoint
ALTER TABLE `presentation_job` ADD `prompt_chars` integer;