CREATE TABLE `artifacts` (
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`content` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `artifacts_run_kind_idx` ON `artifacts` (`run_id`,`kind`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`night_id` text NOT NULL,
	`session_id` text NOT NULL,
	`task_id` text NOT NULL,
	`title` text NOT NULL,
	`repo` text NOT NULL,
	`repo_path` text,
	`type` text,
	`status` text NOT NULL,
	`source` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	`model` text,
	`cost_cents` integer DEFAULT 0 NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`pr_url` text,
	`pr_number` integer,
	`pr_state` text,
	`branch` text,
	`additions` integer,
	`deletions` integer,
	`changed_files` integer,
	`reason` text,
	`summary` text
);
--> statement-breakpoint
CREATE INDEX `runs_night_idx` ON `runs` (`night_id`);--> statement-breakpoint
CREATE INDEX `runs_task_idx` ON `runs` (`task_id`);--> statement-breakpoint
CREATE TABLE `triage` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`action` text NOT NULL,
	`note` text,
	`at` text NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `triage_run_idx` ON `triage` (`run_id`);