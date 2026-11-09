DROP INDEX `actor_bot_display_name_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `actor_bot_display_name_lower_unique` ON `actor` (lower("display_name")) WHERE "kind" = 'bot';--> statement-breakpoint
ALTER TABLE `issue` ADD `source_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_source_key_unique` ON `issue` (`source_key`) WHERE "source_key" is not null;