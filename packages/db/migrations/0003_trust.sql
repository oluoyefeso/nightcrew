CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`title` text NOT NULL,
	`brief` text DEFAULT '' NOT NULL,
	`type` text DEFAULT 'implementation' NOT NULL,
	`scope` text DEFAULT '[]' NOT NULL,
	`criteria` text DEFAULT '[]' NOT NULL,
	`days` text DEFAULT '[]' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_night` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `trains` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`night_id` text NOT NULL,
	`branch` text NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`pr_url` text,
	`pr_number` integer,
	`cars` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `repos` ADD `ship_branch` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `allow_ship` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `repos` ADD `always_ask` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `runs` ADD `confidence` real;--> statement-breakpoint
ALTER TABLE `runs` ADD `ship_sha` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `ship_branch` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `undone_at` text;--> statement-breakpoint
ALTER TABLE `runs` ADD `train_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `source_ref` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `workflow` text DEFAULT 'auto' NOT NULL;