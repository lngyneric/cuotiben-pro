CREATE TABLE `presentation_page_version` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`version` integer NOT NULL,
	`page_no` integer NOT NULL,
	`ops` text DEFAULT '[]' NOT NULL,
	`file_name` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast((julianday('now') - 2440587.5)*86400000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_presentation_page_version_job` ON `presentation_page_version` (`job_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_presentation_page_version_job_version` ON `presentation_page_version` (`job_id`,`version`);