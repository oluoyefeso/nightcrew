CREATE TABLE `repository_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`repo_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`branch` text NOT NULL,
	`sha` text NOT NULL,
	`status` text NOT NULL,
	`detail` text NOT NULL,
	`at` text NOT NULL,
	FOREIGN KEY (`repo_id`) REFERENCES `repos`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `repository_checks_repo_idx` ON `repository_checks` (`repo_id`,`at`);