CREATE TABLE `issue_end_mail` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text NOT NULL,
	`comment_id` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`sent_at` integer,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`event_id`) REFERENCES `activity_event`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`comment_id`) REFERENCES `comment`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "issue_end_mail_status_check" CHECK("status" in ('done', 'canceled')),
	CONSTRAINT "issue_end_mail_state_check" CHECK("state" in ('pending', 'sent', 'skipped', 'failed')),
	CONSTRAINT "issue_end_mail_attempts_check" CHECK("attempts" >= 0),
	CONSTRAINT "issue_end_mail_sent_at_check" CHECK(("state" = 'sent') = ("sent_at" is not null))
) STRICT;
--> statement-breakpoint
CREATE INDEX `issue_end_mail_pending_idx` ON `issue_end_mail` (`next_attempt_at`) WHERE "state" = 'pending';--> statement-breakpoint
CREATE INDEX `issue_end_mail_finished_idx` ON `issue_end_mail` (`created_at`) WHERE "state" <> 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX `issue_end_mail_event_recipient_unique` ON `issue_end_mail` (`event_id`,`recipient_id`);--> statement-breakpoint
-- column constraints, not drizzle-kit's rebuild of actor: its copy step selects the new columns from the old table,
-- and ADD COLUMN can carry a CHECK and a REFERENCES, which every existing row passes with NULL and 0
ALTER TABLE `actor` ADD `handler_id` text REFERENCES actor(id) CONSTRAINT "actor_handler_check" CHECK("handler_id" is null or "kind" = 'bot');--> statement-breakpoint
ALTER TABLE `actor` ADD `issue_end_mail_off` integer DEFAULT false NOT NULL CONSTRAINT "actor_issue_end_mail_off_check" CHECK("issue_end_mail_off" = 0 or ("issue_end_mail_off" = 1 and "kind" = 'human'));--> statement-breakpoint
ALTER TABLE `issue` ADD `filed_for_id` text REFERENCES actor(id);