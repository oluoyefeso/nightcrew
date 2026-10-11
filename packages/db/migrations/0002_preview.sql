ALTER TABLE `repos` ADD `setup_command` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `preview_command` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `preview_url` text;--> statement-breakpoint
ALTER TABLE `repos` ADD `preview_paths` text DEFAULT '["/"]' NOT NULL;