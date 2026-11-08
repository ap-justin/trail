-- Edited from drizzle-kit's draft, whose rebuild copies select the new columns from the old
-- tables. These copies backfill instead: project.key P1, P2… and activity_event.seq in
-- (created_at, id) order, issue.number the same way within each project, and issue_seq as
-- the project's issue count. Bots sharing a display name keep it for the earliest by
-- (created_at, id); each later one becomes "name (id)" so the bot-name index can build.
-- issue.completed_at is updated_at for a done or canceled issue, its last change on record.
ALTER TABLE `actor` ADD `label` text;--> statement-breakpoint
UPDATE `actor` SET "display_name" = "display_name" || ' (' || "id" || ')' WHERE "kind" = 'bot' AND EXISTS (SELECT 1 FROM `actor` AS `earlier` WHERE `earlier`."kind" = 'bot' AND `earlier`."display_name" = `actor`."display_name" AND (`earlier`."created_at" < `actor`."created_at" OR (`earlier`."created_at" = `actor`."created_at" AND `earlier`."id" < `actor`."id")));--> statement-breakpoint
CREATE UNIQUE INDEX `actor_bot_display_name_unique` ON `actor` (`display_name`) WHERE "kind" = 'bot';--> statement-breakpoint
CREATE UNIQUE INDEX `actor_bot_label_unique` ON `actor` (`label`) WHERE "kind" = 'bot' and "label" is not null;--> statement-breakpoint
CREATE TABLE `__new_project` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`issue_seq` integer DEFAULT 0 NOT NULL,
	`external_ref` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_name_check" CHECK(length("name") > 0),
	CONSTRAINT "project_key_check" CHECK(length("key") between 2 and 10 and "key" not glob '*[^A-Z0-9]*'),
	CONSTRAINT "project_issue_seq_check" CHECK("issue_seq" >= 0)
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_project`("id", "key", "name", "description", "issue_seq", "external_ref", "created_by", "created_at", "updated_at") SELECT "id", 'P' || row_number() OVER (ORDER BY "created_at", "id"), "name", "description", (SELECT count(*) FROM `issue` WHERE `issue`."project_id" = `project`."id"), NULL, "created_by", "created_at", "updated_at" FROM `project`;--> statement-breakpoint
DROP TABLE `project`;--> statement-breakpoint
ALTER TABLE `__new_project` RENAME TO `project`;--> statement-breakpoint
CREATE UNIQUE INDEX `project_key_unique` ON `project` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_external_ref_unique` ON `project` (`external_ref`) WHERE "external_ref" is not null;--> statement-breakpoint
CREATE TABLE `__new_issue` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`estimate` real,
	`priority` integer DEFAULT 0 NOT NULL,
	`assignee_id` text,
	`created_by` text NOT NULL,
	`external_ref` text,
	`source_author` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "issue_status_check" CHECK("status" in ('open', 'in_progress', 'done', 'canceled')),
	CONSTRAINT "issue_title_check" CHECK(length("title") > 0),
	CONSTRAINT "issue_number_check" CHECK("number" > 0),
	CONSTRAINT "issue_estimate_check" CHECK("estimate" >= 0),
	CONSTRAINT "issue_priority_check" CHECK("priority" between 0 and 4),
	CONSTRAINT "issue_completed_at_check" CHECK(("status" in ('done', 'canceled')) = ("completed_at" is not null))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_issue`("id", "project_id", "number", "title", "description", "status", "estimate", "priority", "assignee_id", "created_by", "external_ref", "source_author", "created_at", "updated_at", "completed_at") SELECT "id", "project_id", row_number() OVER (PARTITION BY "project_id" ORDER BY "created_at", "id"), "title", "description", "status", NULL, 0, "assignee_id", "created_by", NULL, NULL, "created_at", "updated_at", CASE WHEN "status" IN ('done', 'canceled') THEN "updated_at" END FROM `issue`;--> statement-breakpoint
DROP TABLE `issue`;--> statement-breakpoint
ALTER TABLE `__new_issue` RENAME TO `issue`;--> statement-breakpoint
CREATE INDEX `issue_project_status_created_idx` ON `issue` (`project_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `issue_project_created_idx` ON `issue` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `issue_assignee_created_idx` ON `issue` (`assignee_id`,`created_at`,`id`) WHERE "assignee_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_project_number_unique` ON `issue` (`project_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_project_external_ref_unique` ON `issue` (`project_id`,`external_ref`) WHERE "external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_id_project_unique` ON `issue` (`id`,`project_id`);--> statement-breakpoint
ALTER TABLE `comment` ADD `external_ref` text;--> statement-breakpoint
ALTER TABLE `comment` ADD `source_author` text;--> statement-breakpoint
CREATE UNIQUE INDEX `comment_issue_external_ref_unique` ON `comment` (`issue_id`,`external_ref`) WHERE "external_ref" is not null;--> statement-breakpoint
CREATE TABLE `label` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "label_name_check" CHECK(length("name") > 0)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `label_project_name_unique` ON `label` (`project_id`,"name" collate nocase);--> statement-breakpoint
CREATE UNIQUE INDEX `label_id_project_unique` ON `label` (`id`,`project_id`);--> statement-breakpoint
CREATE TABLE `issue_label` (
	`issue_id` text NOT NULL,
	`label_id` text NOT NULL,
	`project_id` text NOT NULL,
	PRIMARY KEY(`issue_id`, `label_id`),
	FOREIGN KEY (`issue_id`,`project_id`) REFERENCES `issue`(`id`,`project_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`label_id`,`project_id`) REFERENCES `label`(`id`,`project_id`) ON UPDATE no action ON DELETE cascade
) STRICT;--> statement-breakpoint
CREATE TABLE `idempotency_key` (
	`actor_id` text NOT NULL,
	`key` text NOT NULL,
	`scope` text NOT NULL,
	`request_hash` text NOT NULL,
	`response` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`actor_id`, `key`),
	FOREIGN KEY (`actor_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "idempotency_key_key_check" CHECK(length("key") > 0),
	CONSTRAINT "idempotency_key_scope_check" CHECK(length("scope") > 0),
	CONSTRAINT "idempotency_key_request_hash_check" CHECK(length("request_hash") > 0),
	CONSTRAINT "idempotency_key_response_check" CHECK(json_valid("response"))
) STRICT;--> statement-breakpoint
CREATE TABLE `issue_link` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`url` text NOT NULL,
	`title` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "issue_link_url_check" CHECK(length("url") > 0),
	CONSTRAINT "issue_link_title_check" CHECK(length("title") > 0)
) STRICT;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_link_issue_url_unique` ON `issue_link` (`issue_id`,`url`);--> statement-breakpoint
CREATE TABLE `project_status_update` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`health` text NOT NULL,
	`external_ref` text,
	`source_author` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_status_update_body_check" CHECK(length("body") > 0),
	CONSTRAINT "project_status_update_health_check" CHECK("health" in ('on_track', 'at_risk', 'off_track'))
) STRICT;--> statement-breakpoint
CREATE INDEX `project_status_update_project_created_idx` ON `project_status_update` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `project_status_update_project_external_ref_unique` ON `project_status_update` (`project_id`,`external_ref`) WHERE "external_ref" is not null;--> statement-breakpoint
CREATE TABLE `__new_activity_event` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`actor_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`project_id` text,
	`action` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "activity_event_subject_type_check" CHECK("subject_type" in ('project', 'issue', 'comment', 'label', 'status_update')),
	CONSTRAINT "activity_event_action_check" CHECK(length("action") > 0),
	CONSTRAINT "activity_event_payload_check" CHECK(json_valid("payload")),
	CONSTRAINT "activity_event_seq_check" CHECK("seq" > 0)
) STRICT;--> statement-breakpoint
INSERT INTO `__new_activity_event`("id", "seq", "actor_id", "subject_type", "subject_id", "project_id", "action", "payload", "created_at") SELECT "id", row_number() OVER (ORDER BY "created_at", "id"), "actor_id", "subject_type", "subject_id", "project_id", "action", "payload", "created_at" FROM `activity_event`;--> statement-breakpoint
DROP TABLE `activity_event`;--> statement-breakpoint
ALTER TABLE `__new_activity_event` RENAME TO `activity_event`;--> statement-breakpoint
CREATE UNIQUE INDEX `activity_event_seq_unique` ON `activity_event` (`seq`);--> statement-breakpoint
CREATE INDEX `activity_event_project_seq_idx` ON `activity_event` (`project_id`,`seq`);--> statement-breakpoint
CREATE INDEX `activity_event_actor_seq_idx` ON `activity_event` (`actor_id`,`seq`);
