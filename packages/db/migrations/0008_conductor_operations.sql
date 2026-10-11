CREATE TABLE `audit` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`action` text NOT NULL,
	`subject_id` text NOT NULL,
	`detail` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `checkpoints` (
	`task_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`stage` text NOT NULL,
	`fingerprint` text NOT NULL,
	`sha` text NOT NULL,
	`plan` text,
	`summary` text,
	`at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`sha` text NOT NULL,
	`branch` text NOT NULL,
	`policy` text NOT NULL,
	`stage` text NOT NULL,
	`status` text NOT NULL,
	`log` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `deliveries_repo_idx` ON `deliveries` (`repo_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `mission_acceptances` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`at` text NOT NULL,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`checks` text NOT NULL,
	`evidence` text NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `policy_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`policies` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `missions` ADD `criteria` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `missions` ADD `token_budget` integer;--> statement-breakpoint
ALTER TABLE `missions` ADD `priority` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `missions` ADD `deadline` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `delivery` text DEFAULT '{"branch":"","check":"","deploy":"","release":"","automatic":"off","environment":[]}' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `mission_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `recovery_mode` text DEFAULT 'auto' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `auto_retries` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE runs SET mission_id = (SELECT mission_id FROM tasks WHERE tasks.id = runs.task_id) WHERE source = 'local';

--> statement-breakpoint
CREATE INDEX runs_mission_idx ON runs (mission_id);
