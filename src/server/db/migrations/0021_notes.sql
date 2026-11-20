CREATE TABLE `note_about` (
	`note_id` text NOT NULL,
	`item_id` text NOT NULL,
	PRIMARY KEY(`note_id`, `item_id`),
	FOREIGN KEY (`note_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `issue`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "note_about_self_check" CHECK("note_id" <> "item_id")
) STRICT;
--> statement-breakpoint
CREATE INDEX `note_about_item_note_idx` ON `note_about` (`item_id`,`note_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
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
	CONSTRAINT "issue_status_check" CHECK("status" in ('triage', 'open', 'in_progress', 'done', 'canceled', 'current', 'archived')),
	CONSTRAINT "issue_type_check" CHECK("type" in ('issue', 'todo', 'note')),
	CONSTRAINT "issue_todo_status_check" CHECK("type" <> 'todo' or "status" <> 'triage'),
	CONSTRAINT "issue_note_status_check" CHECK(("type" = 'note') = ("status" in ('current', 'archived'))),
	CONSTRAINT "issue_note_assignee_check" CHECK("type" <> 'note' or "assignee_id" is null),
	CONSTRAINT "issue_note_rank_check" CHECK("type" <> 'note' or ("priority" = 0 and "estimate" is null)),
	CONSTRAINT "issue_title_check" CHECK(length("title") > 0),
	CONSTRAINT "issue_number_check" CHECK("number" > 0),
	CONSTRAINT "issue_estimate_check" CHECK("estimate" >= 0),
	CONSTRAINT "issue_priority_check" CHECK("priority" between 0 and 4),
	CONSTRAINT "issue_source_status_check" CHECK(length("source_status") <= 200),
	CONSTRAINT "issue_completed_at_check" CHECK(("status" in ('done', 'canceled')) = ("completed_at" is not null))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_issue`("id", "product_id", "number", "type", "title", "description", "status", "estimate", "priority", "assignee_id", "created_by", "external_ref", "source_author", "source_status", "source_key", "created_at", "updated_at", "completed_at") SELECT "id", "product_id", "number", "type", "title", "description", "status", "estimate", "priority", "assignee_id", "created_by", "external_ref", "source_author", "source_status", "source_key", "created_at", "updated_at", "completed_at" FROM `issue`;--> statement-breakpoint
DROP TABLE `issue`;--> statement-breakpoint
ALTER TABLE `__new_issue` RENAME TO `issue`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_product_external_ref_unique` ON `issue` (`product_id`,`external_ref`) WHERE "external_ref" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_source_key_unique` ON `issue` (`source_key`) WHERE "source_key" is not null;--> statement-breakpoint
CREATE INDEX `issue_product_status_created_idx` ON `issue` (`product_id`,`status`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `issue_product_created_idx` ON `issue` (`product_id`,`created_at`,`id`);--> statement-breakpoint
CREATE INDEX `issue_assignee_created_idx` ON `issue` (`assignee_id`,`created_at`,`id`) WHERE "assignee_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `issue_product_number_unique` ON `issue` (`product_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `issue_id_product_unique` ON `issue` (`id`,`product_id`);