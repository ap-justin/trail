-- Hand-written: drizzle-kit would drop and re-create every renamed table. `project` becomes
-- `product` with its rows and ids, and so do its join tables and every project_id column;
-- renames come first so SQLite rewrites each referencing foreign key, then the tables whose
-- named CHECKs or columns change are rebuilt, then the new `project` tables are created.
-- Items are copied as type 'issue'; migrate() in client.ts then resolves product owners and
-- turns each owner's own items into todos, in this same transaction.
ALTER TABLE `project` RENAME TO `product`;--> statement-breakpoint
CREATE TABLE `__new_product` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`issue_seq` integer DEFAULT 0 NOT NULL,
	`external_ref` text,
	`owner_id` text,
	`repo_url` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "product_name_check" CHECK(length("name") > 0),
	CONSTRAINT "product_key_check" CHECK(length("key") between 2 and 10 and "key" not glob '*[^A-Z0-9]*'),
	CONSTRAINT "product_issue_seq_check" CHECK("issue_seq" >= 0),
	CONSTRAINT "product_repo_url_check" CHECK("repo_url" is null or (length("repo_url") <= 200 and "repo_url" glob 'https://github.com/?*/?*' and "repo_url" not glob 'https://github.com/*/*/*' and substr("repo_url", 20) not glob '*[^A-Za-z0-9._/-]*'))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_product`("id", "key", "name", "description", "issue_seq", "external_ref", "created_by", "created_at", "updated_at") SELECT "id", "key", "name", "description", "issue_seq", "external_ref", "created_by", "created_at", "updated_at" FROM `product`;--> statement-breakpoint
DROP TABLE `product`;--> statement-breakpoint
ALTER TABLE `__new_product` RENAME TO `product`;--> statement-breakpoint
CREATE UNIQUE INDEX `product_key_unique` ON `product` (`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_external_ref_unique` ON `product` (`external_ref`) WHERE "external_ref" is not null;--> statement-breakpoint
ALTER TABLE `api_key_project` RENAME TO `api_key_product`;--> statement-breakpoint
ALTER TABLE `api_key_product` RENAME COLUMN `project_id` TO `product_id`;--> statement-breakpoint
DROP INDEX `api_key_project_project_key_idx`;--> statement-breakpoint
CREATE INDEX `api_key_product_product_key_idx` ON `api_key_product` (`product_id`,`api_key_id`);--> statement-breakpoint
ALTER TABLE `project_member` RENAME TO `product_member`;--> statement-breakpoint
ALTER TABLE `product_member` RENAME COLUMN `project_id` TO `product_id`;--> statement-breakpoint
DROP INDEX `project_member_project_invite_idx`;--> statement-breakpoint
CREATE INDEX `product_member_product_invite_idx` ON `product_member` (`product_id`,`invite_id`);--> statement-breakpoint
-- renaming the parent columns rewrites issue_label's keys that reference them
ALTER TABLE `label` RENAME COLUMN `project_id` TO `product_id`;--> statement-breakpoint
DROP INDEX `label_project_name_unique`;--> statement-breakpoint
DROP INDEX `label_id_project_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `label_product_name_unique` ON `label` (`product_id`,"name" collate nocase);--> statement-breakpoint
CREATE UNIQUE INDEX `label_id_product_unique` ON `label` (`id`,`product_id`);--> statement-breakpoint
ALTER TABLE `issue` RENAME COLUMN `project_id` TO `product_id`;--> statement-breakpoint
ALTER TABLE `issue_label` RENAME COLUMN `project_id` TO `product_id`;--> statement-breakpoint
CREATE TABLE `__new_issue` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`number` integer NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`estimate` real,
	`priority` integer DEFAULT 0 NOT NULL,
	`assignee_id` text,
	`created_by` text NOT NULL,
	`external_ref` text,
	`source_author` text,
	`source_status` text,
	`source_key` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`assignee_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "issue_status_check" CHECK("status" in ('triage', 'open', 'in_progress', 'done', 'canceled')),
	CONSTRAINT "issue_type_check" CHECK("type" in ('issue', 'todo')),
	CONSTRAINT "issue_todo_status_check" CHECK("type" <> 'todo' or "status" <> 'triage'),
	CONSTRAINT "issue_title_check" CHECK(length("title") > 0),
	CONSTRAINT "issue_number_check" CHECK("number" > 0),
	CONSTRAINT "issue_estimate_check" CHECK("estimate" >= 0),
	CONSTRAINT "issue_priority_check" CHECK("priority" between 0 and 4),
	CONSTRAINT "issue_source_status_check" CHECK(length("source_status") <= 200),
	CONSTRAINT "issue_completed_at_check" CHECK(("status" in ('done', 'canceled')) = ("completed_at" is not null))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_issue`("id", "product_id", "number", "type", "title", "description", "status", "estimate", "priority", "assignee_id", "created_by", "external_ref", "source_author", "source_status", "source_key", "created_at", "updated_at", "completed_at") SELECT "id", "product_id", "number", 'issue', "title", "description", "status", "estimate", "priority", "assignee_id", "created_by", "external_ref", "source_author", "source_status", "source_key", "created_at", "updated_at", "completed_at" FROM `issue`;--> statement-breakpoint
DROP TABLE `issue`;--> statement-breakpoint
ALTER TABLE `__new_issue` RENAME TO `issue`;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_product_external_ref_unique` ON `issue` (`product_id`,`external_ref`) WHERE "external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_source_key_unique` ON `issue` (`source_key`) WHERE "source_key" is not null;--> statement-breakpoint
CREATE INDEX `issue_product_status_created_idx` ON `issue` (`product_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `issue_product_created_idx` ON `issue` (`product_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `issue_assignee_created_idx` ON `issue` (`assignee_id`,`created_at`,`id`) WHERE "assignee_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_product_number_unique` ON `issue` (`product_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_id_product_unique` ON `issue` (`id`,`product_id`);--> statement-breakpoint
CREATE TABLE `product_status_update` (
	`id` text PRIMARY KEY NOT NULL,
	`product_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`health` text NOT NULL,
	`external_ref` text,
	`source_author` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "product_status_update_body_check" CHECK(length("body") > 0),
	CONSTRAINT "product_status_update_health_check" CHECK("health" in ('on_track', 'at_risk', 'off_track'))
) STRICT;
--> statement-breakpoint
INSERT INTO `product_status_update`("id", "product_id", "author_id", "body", "health", "external_ref", "source_author", "created_at") SELECT "id", "project_id", "author_id", "body", "health", "external_ref", "source_author", "created_at" FROM `project_status_update`;--> statement-breakpoint
DROP TABLE `project_status_update`;--> statement-breakpoint
CREATE INDEX `product_status_update_product_created_idx` ON `product_status_update` (`product_id`,`created_at`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `product_status_update_product_external_ref_unique` ON `product_status_update` (`product_id`,`external_ref`) WHERE "external_ref" is not null;--> statement-breakpoint
CREATE TABLE `__new_activity_event` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`actor_id` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`product_id` text,
	`project_id` text,
	`action` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "activity_event_subject_type_check" CHECK("subject_type" in ('product', 'project', 'issue', 'comment', 'label', 'status_update')),
	CONSTRAINT "activity_event_action_check" CHECK(length("action") > 0),
	CONSTRAINT "activity_event_payload_check" CHECK(json_valid("payload")),
	CONSTRAINT "activity_event_seq_check" CHECK("seq" > 0)
) STRICT;
--> statement-breakpoint
-- every stored project event was about what is now a product; webhook_delivery rows keep the type they were sent with
INSERT INTO `__new_activity_event`("id", "seq", "actor_id", "subject_type", "subject_id", "product_id", "project_id", "action", "payload", "created_at") SELECT "id", "seq", "actor_id", CASE WHEN "subject_type" = 'project' THEN 'product' ELSE "subject_type" END, "subject_id", "project_id", NULL, CASE WHEN substr("action", 1, 8) = 'project.' THEN 'product.' || substr("action", 9) ELSE "action" END, "payload", "created_at" FROM `activity_event`;--> statement-breakpoint
DROP TABLE `activity_event`;--> statement-breakpoint
ALTER TABLE `__new_activity_event` RENAME TO `activity_event`;--> statement-breakpoint
CREATE UNIQUE INDEX `activity_event_seq_unique` ON `activity_event` (`seq`);--> statement-breakpoint
CREATE INDEX `activity_event_product_seq_idx` ON `activity_event` (`product_id`,`seq`);--> statement-breakpoint
CREATE INDEX `activity_event_project_seq_idx` ON `activity_event` (`project_id`,`seq`);--> statement-breakpoint
CREATE INDEX `activity_event_actor_seq_idx` ON `activity_event` (`actor_id`,`seq`);--> statement-breakpoint
CREATE INDEX `activity_event_actor_product_idx` ON `activity_event` (`actor_id`,`product_id`);--> statement-breakpoint
CREATE INDEX `activity_event_subject_seq_idx` ON `activity_event` (`subject_id`,`seq`);--> statement-breakpoint
ALTER TABLE `webhook_subscription_project` RENAME TO `webhook_subscription_product`;--> statement-breakpoint
ALTER TABLE `webhook_subscription_product` RENAME COLUMN `project_id` TO `product_id`;--> statement-breakpoint
DROP INDEX `webhook_subscription_project_project_idx`;--> statement-breakpoint
CREATE INDEX `webhook_subscription_product_product_idx` ON `webhook_subscription_product` (`product_id`,`subscription_id`);--> statement-breakpoint
-- a product event is delivered under both trail.product.* and trail.project.*; rows unique per (subscription, event) stay unique with type added
DROP INDEX `webhook_delivery_subscription_event_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `webhook_delivery_subscription_event_type_unique` ON `webhook_delivery` (`subscription_id`,`event_id`,`type`);--> statement-breakpoint
CREATE TABLE `project` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`lead_id` text NOT NULL,
	`target_date` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`lead_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`created_by`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_slug_check" CHECK(length("slug") between 2 and 39 and "slug" not glob '*[^a-z0-9-]*' and "slug" not glob '-*'),
	CONSTRAINT "project_name_check" CHECK(length("name") > 0),
	CONSTRAINT "project_target_date_check" CHECK("target_date" is null or ("target_date" glob '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' and date("target_date") = "target_date"))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `project_slug_unique` ON `project` (`slug`);--> statement-breakpoint
CREATE TABLE `project_product` (
	`project_id` text NOT NULL,
	`product_id` text NOT NULL,
	PRIMARY KEY(`project_id`, `product_id`),
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`product_id`) REFERENCES `product`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `project_product_product_project_idx` ON `project_product` (`product_id`,`project_id`);--> statement-breakpoint
CREATE TABLE `project_item` (
	`project_id` text NOT NULL,
	`issue_id` text NOT NULL,
	`product_id` text NOT NULL,
	`added_by` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`project_id`, `issue_id`),
	FOREIGN KEY (`added_by`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`,`product_id`) REFERENCES `project_product`(`project_id`,`product_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`issue_id`,`product_id`) REFERENCES `issue`(`id`,`product_id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `project_item_issue_idx` ON `project_item` (`issue_id`);--> statement-breakpoint
CREATE TABLE `project_status_update` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`author_id` text NOT NULL,
	`body` text NOT NULL,
	`health` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`author_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "project_status_update_body_check" CHECK(length("body") > 0),
	CONSTRAINT "project_status_update_health_check" CHECK("health" in ('on_track', 'at_risk', 'off_track'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `project_status_update_project_created_idx` ON `project_status_update` (`project_id`,`created_at`,`id`);
