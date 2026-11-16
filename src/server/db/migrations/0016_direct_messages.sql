CREATE TABLE `message` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`sender_id` text NOT NULL,
	`recipient_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`reply_to_id` text,
	`text` text NOT NULL,
	`expects_reply` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`read_at` integer,
	FOREIGN KEY (`sender_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`recipient_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reply_to_id`,`thread_id`) REFERENCES `message`(`id`,`thread_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "message_seq_check" CHECK("seq" > 0),
	CONSTRAINT "message_participants_check" CHECK("sender_id" <> "recipient_id"),
	CONSTRAINT "message_text_check" CHECK(length("text") > 0),
	CONSTRAINT "message_expects_reply_check" CHECK("expects_reply" in (0, 1)),
	CONSTRAINT "message_thread_check" CHECK(("reply_to_id" is null) = ("thread_id" = "id"))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `message_seq_unique` ON `message` (`seq`);--> statement-breakpoint
CREATE INDEX `message_recipient_seq_idx` ON `message` (`recipient_id`,`seq`);--> statement-breakpoint
CREATE INDEX `message_recipient_unread_seq_idx` ON `message` (`recipient_id`,`seq`) WHERE "read_at" is null;--> statement-breakpoint
CREATE INDEX `message_thread_seq_idx` ON `message` (`thread_id`,`seq`);--> statement-breakpoint
CREATE INDEX `message_sender_recipient_created_idx` ON `message` (`sender_id`,`recipient_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `message_pair_seq_idx` ON `message` (case when "sender_id" < "recipient_id" then "sender_id" else "recipient_id" end,case when "sender_id" < "recipient_id" then "recipient_id" else "sender_id" end,`seq`,`sender_id`,`recipient_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `message_id_thread_unique` ON `message` (`id`,`thread_id`);--> statement-breakpoint
-- event_id becomes nullable, so webhook_delivery is rebuilt; nothing references it, and migrate() in
-- client.ts turns foreign keys off around the transaction. Hand-edited from drizzle-kit's draft, which
-- copies a message_id the old table lacks: every existing row is an event delivery, message_id NULL.
CREATE TABLE `__new_webhook_delivery` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`event_id` text,
	`message_id` text,
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
	FOREIGN KEY (`message_id`) REFERENCES `message`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "webhook_delivery_status_check" CHECK("status" in ('pending', 'delivered', 'failed')),
	CONSTRAINT "webhook_delivery_attempts_check" CHECK("attempts" >= 0),
	CONSTRAINT "webhook_delivery_subject_check" CHECK(("event_id" is null) <> ("message_id" is null))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_webhook_delivery`("id", "subscription_id", "event_id", "message_id", "seq", "type", "status", "body", "attempts", "next_attempt_at", "last_status", "last_error", "created_at", "delivered_at") SELECT "id", "subscription_id", "event_id", NULL, "seq", "type", "status", "body", "attempts", "next_attempt_at", "last_status", "last_error", "created_at", "delivered_at" FROM `webhook_delivery`;--> statement-breakpoint
DROP TABLE `webhook_delivery`;--> statement-breakpoint
ALTER TABLE `__new_webhook_delivery` RENAME TO `webhook_delivery`;--> statement-breakpoint
CREATE INDEX `webhook_delivery_pending_idx` ON `webhook_delivery` (`subscription_id`,`seq`) WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX `webhook_delivery_pending_age_idx` ON `webhook_delivery` (`subscription_id`,`created_at`) WHERE "status" = 'pending';--> statement-breakpoint
CREATE INDEX `webhook_delivery_delivered_idx` ON `webhook_delivery` (`delivered_at`) WHERE "status" = 'delivered';--> statement-breakpoint
CREATE INDEX `webhook_delivery_failed_idx` ON `webhook_delivery` (`created_at`) WHERE "status" = 'failed';--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_delivery_subscription_message_unique` ON `webhook_delivery` (`subscription_id`,`message_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_delivery_subscription_event_type_unique` ON `webhook_delivery` (`subscription_id`,`event_id`,`type`);--> statement-breakpoint
-- a column constraint, not drizzle-kit's rebuild of webhook_subscription: ADD COLUMN can carry the
-- CHECK and a NOT NULL with a default, which makes every existing subscription an activity one
ALTER TABLE `webhook_subscription` ADD `kind` text DEFAULT 'activity' NOT NULL CONSTRAINT "webhook_subscription_kind_check" CHECK("kind" in ('activity', 'inbox'));