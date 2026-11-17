CREATE TABLE `api_key_project` (
	`api_key_id` text NOT NULL,
	`project_id` text NOT NULL,
	PRIMARY KEY(`api_key_id`, `project_id`),
	FOREIGN KEY (`api_key_id`) REFERENCES `api_key`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `api_key_project_project_key_idx` ON `api_key_project` (`project_id`,`api_key_id`);--> statement-breakpoint
CREATE TABLE `webhook_subscription_project` (
	`subscription_id` text NOT NULL,
	`project_id` text NOT NULL,
	PRIMARY KEY(`subscription_id`, `project_id`),
	FOREIGN KEY (`subscription_id`) REFERENCES `webhook_subscription`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `webhook_subscription_project_project_idx` ON `webhook_subscription_project` (`project_id`,`subscription_id`);