CREATE TABLE `webhook_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`event_id` text NOT NULL,
	`seq` integer NOT NULL,
	`type` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`body` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_status` integer,
	`last_error` text,
	`created_at` integer NOT NULL,
	`delivered_at` integer,
	FOREIGN KEY (`subscription_id`) REFERENCES `webhook_subscription`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `activity_event`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "webhook_delivery_status_check" CHECK("status" in ('pending', 'delivered', 'failed')),
	CONSTRAINT "webhook_delivery_attempts_check" CHECK("attempts" >= 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `webhook_delivery_pending_idx` ON `webhook_delivery` (`subscription_id`,`seq`) WHERE "status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_delivery_subscription_event_unique` ON `webhook_delivery` (`subscription_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `webhook_subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`url` text NOT NULL,
	`secret_cipher` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`paused_at` integer,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`last_success_at` integer,
	`last_error` text,
	`last_error_at` integer,
	FOREIGN KEY (`actor_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "webhook_subscription_url_check" CHECK(length("url") > 0),
	CONSTRAINT "webhook_subscription_failures_check" CHECK("consecutive_failures" >= 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_subscription_actor_url_unique` ON `webhook_subscription` (`actor_id`,`url`);--> statement-breakpoint
CREATE TABLE `webhook_subscription_project` (
	`subscription_id` text NOT NULL,
	`project_id` text NOT NULL,
	PRIMARY KEY(`subscription_id`, `project_id`),
	FOREIGN KEY (`subscription_id`) REFERENCES `webhook_subscription`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `webhook_subscription_project_project_idx` ON `webhook_subscription_project` (`project_id`,`subscription_id`);