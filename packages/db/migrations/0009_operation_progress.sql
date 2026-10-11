CREATE TABLE `operation_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`stage` text,
	`status` text NOT NULL,
	`phase` text NOT NULL,
	`repo_id` text,
	`result_id` text,
	`detail` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `operation_jobs_subject_idx` ON `operation_jobs` (`kind`,`subject_id`,`created_at`);