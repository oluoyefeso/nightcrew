CREATE TABLE `missions` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `mission_id` text REFERENCES missions(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `tasks_mission_idx` ON `tasks` (`mission_id`);
