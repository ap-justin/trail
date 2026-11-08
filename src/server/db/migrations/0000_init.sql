CREATE TABLE `activity_event` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`project_id` text,
	`action` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "activity_event_subject_type_check" CHECK("subject_type" in ('project', 'issue', 'comment')),
	CONSTRAINT "activity_event_action_check" CHECK(length("action") > 0),
	CONSTRAINT "activity_event_payload_check" CHECK(json_valid("payload"))
) STRICT;
--> statement-breakpoint
CREATE INDEX `activity_event_created_idx` ON `activity_event` (`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `activity_event_project_created_idx` ON `activity_event` (`project_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `activity_event_actor_created_idx` ON `activity_event` (`actor_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `actor` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`display_name` text NOT NULL,
	`github_id` integer,
	`created_at` integer NOT NULL,
	CONSTRAINT "actor_kind_check" CHECK("kind" in ('human', 'bot')),
	CONSTRAINT "actor_display_name_check" CHECK(length("display_name") > 0),
	CONSTRAINT "actor_github_id_check" CHECK("kind" = 'human' or "github_id" is null)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `actor_github_id_unique` ON `actor` (`github_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `actor_id_kind_unique` ON `actor` (`id`,`kind`);--> statement-breakpoint
CREATE TABLE `api_key` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`actor_kind` text DEFAULT 'bot' NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`actor_id`,`actor_kind`) REFERENCES `actor`(`id`,`kind`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "api_key_actor_kind_check" CHECK("actor_kind" = 'bot'),
	CONSTRAINT "api_key_hash_check" CHECK(length("hash") = 64)
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `api_key_prefix_unique` ON `api_key` (`prefix`);--> statement-breakpoint
CREATE TABLE `comment` (
	`id` text PRIMARY KEY NOT NULL,
	`issue_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`issue_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "comment_body_check" CHECK(length("body") > 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `comment_issue_created_idx` ON `comment` (`issue_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `issue` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`assignee_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "issue_status_check" CHECK("status" in ('open', 'in_progress', 'done', 'canceled')),
	CONSTRAINT "issue_title_check" CHECK(length("title") > 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `issue_project_status_created_idx` ON `issue` (`project_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `issue_assignee_created_idx` ON `issue` (`assignee_id`,`created_at`,`id`) WHERE "assignee_id" is not null;--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_name_check" CHECK(length("name") > 0)
) STRICT;
