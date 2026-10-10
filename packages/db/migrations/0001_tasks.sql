CREATE TABLE `repos` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`path` text NOT NULL,
	`default_branch` text DEFAULT 'main' NOT NULL,
	`protected_branches` text DEFAULT '[]' NOT NULL,
	`test_command` text,
	`level` text DEFAULT 'draft_pr' NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `repos_path_unique` ON `repos` (`path`);--> statement-breakpoint
CREATE TABLE `run_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`at` text NOT NULL,
	`phase` text NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`data` text
);
--> statement-breakpoint
CREATE INDEX `run_events_run_idx` ON `run_events` (`run_id`,`id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_notes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` text NOT NULL,
	`author` text NOT NULL,
	`body` text NOT NULL,
	`run_id` text,
	`at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `task_notes_task_idx` ON `task_notes` (`task_id`);--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`title` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`type` text DEFAULT 'implementation' NOT NULL,
	`scope` text DEFAULT '[]' NOT NULL,
	`criteria` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`depends_on` text DEFAULT '[]' NOT NULL,
	`budget_cents` integer DEFAULT 200 NOT NULL,
	`max_minutes` integer DEFAULT 45 NOT NULL,
	`branch` text NOT NULL,
	`model` text,
	`test_command` text,
	`question` text,
	`source` text DEFAULT 'manual' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_run_id` text,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `tasks_status_idx` ON `tasks` (`status`,`position`);--> statement-breakpoint
ALTER TABLE `runs` ADD `phase` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `worktree` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `verdict` text;