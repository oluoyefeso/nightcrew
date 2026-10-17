CREATE TABLE `goal_conductors` (
	`mission_id` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `goal_results` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`body` text NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `goal_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`day_id` text NOT NULL,
	`phase` text NOT NULL,
	`status` text NOT NULL,
	`reserved` integer NOT NULL,
	`charged` integer NOT NULL,
	`tokens_in` integer DEFAULT 0 NOT NULL,
	`tokens_out` integer DEFAULT 0 NOT NULL,
	`cost_usd` real DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_handoffs` (
	`task_id` text PRIMARY KEY NOT NULL,
	`fingerprint` text NOT NULL,
	`base` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
