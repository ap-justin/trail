CREATE TABLE `__new_invite` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text,
	`email` text,
	`invited_by` text NOT NULL,
	`github_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invited_by`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invite_username_check" CHECK(length("username") between 1 and 39 and "username" not glob '*[^a-z0-9-]*' and "username" not glob '-*' and "username" not glob '*-' and "username" not glob '*--*'),
	CONSTRAINT "invite_email_check" CHECK(length("email") between 3 and 254 and "email" = lower("email") and "email" glob '?*@?*.?*' and "email" not glob '*@*@*' and "email" not glob ('*[' || char(9, 10, 13, 32) || ']*')),
	CONSTRAINT "invite_kind_check" CHECK(("username" is null) <> ("email" is null)),
	CONSTRAINT "invite_github_id_check" CHECK("github_id" is null or "username" is not null)
) STRICT;
--> statement-breakpoint
-- every invite so far is a GitHub invite
INSERT INTO `__new_invite`("username", "invited_by", "github_id", "created_at") SELECT "username", "invited_by", "github_id", "created_at" FROM `invite` ORDER BY "created_at", "username";--> statement-breakpoint
CREATE TABLE `__new_project_member` (
	`invite_id` integer NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`invite_id`, `project_id`),
	FOREIGN KEY (`invite_id`) REFERENCES `invite`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_project_member`("invite_id", "project_id", "created_at") SELECT i."id", m."project_id", m."created_at" FROM `project_member` m JOIN `__new_invite` i ON i."username" = m."username";--> statement-breakpoint
DROP TABLE `project_member`;--> statement-breakpoint
DROP TABLE `invite`;--> statement-breakpoint
ALTER TABLE `__new_invite` RENAME TO `invite`;--> statement-breakpoint
ALTER TABLE `__new_project_member` RENAME TO `project_member`;--> statement-breakpoint
CREATE UNIQUE INDEX `invite_username_unique` ON `invite` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `invite_email_unique` ON `invite` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `invite_github_id_unique` ON `invite` (`github_id`) WHERE "github_id" is not null;--> statement-breakpoint
CREATE INDEX `project_member_project_invite_idx` ON `project_member` (`project_id`,`invite_id`);--> statement-breakpoint
-- 0007's trigger went with the old table; drizzle-kit doesn't model triggers
CREATE TRIGGER `invite_github_id_pinned` BEFORE UPDATE OF `github_id` ON `invite`
WHEN old.`github_id` IS NOT NULL AND new.`github_id` IS NOT old.`github_id`
BEGIN
	SELECT RAISE(ABORT, 'invite.github_id is bound to the account that claimed it and cannot change');
END;--> statement-breakpoint
-- a column constraint, not drizzle-kit's rebuild of actor: ADD COLUMN can carry a CHECK, and every NULL passes it
ALTER TABLE `actor` ADD `email` text CONSTRAINT "actor_email_check" CHECK("email" is null or ("kind" = 'human' and "github_id" is null and length("email") between 3 and 254 and "email" = lower("email") and "email" glob '?*@?*.?*' and "email" not glob '*@*@*' and "email" not glob ('*[' || char(9, 10, 13, 32) || ']*')));--> statement-breakpoint
CREATE UNIQUE INDEX `actor_email_unique` ON `actor` (`email`) WHERE "email" is not null;
--> statement-breakpoint
-- a person signed in by email has a better-auth user with no GitHub account
CREATE TABLE `__new_user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`github_id` integer,
	`github_login` text,
	CONSTRAINT "user_github_check" CHECK(("github_id" is null) = ("github_login" is null))
) STRICT;
--> statement-breakpoint
INSERT INTO `__new_user`("id", "name", "email", "email_verified", "image", "created_at", "updated_at", "github_id", "github_login") SELECT "id", "name", "email", "email_verified", "image", "created_at", "updated_at", "github_id", "github_login" FROM `user`;--> statement-breakpoint
DROP TABLE `user`;--> statement-breakpoint
ALTER TABLE `__new_user` RENAME TO `user`;--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `user_github_id_unique` ON `user` (`github_id`);
