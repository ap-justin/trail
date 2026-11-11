CREATE TABLE `invite` (
	`username` text PRIMARY KEY NOT NULL,
	`invited_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invited_by`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "invite_username_check" CHECK(length("username") between 1 and 39 and "username" not glob '*[^a-z0-9-]*' and "username" not glob '-*' and "username" not glob '*-' and "username" not glob '*--*')
) STRICT;
--> statement-breakpoint
CREATE TABLE `project_member` (
	`username` text NOT NULL,
	`project_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`username`, `project_id`),
	FOREIGN KEY (`username`) REFERENCES `invite`(`username`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `project_member_project_username_idx` ON `project_member` (`project_id`,`username`);--> statement-breakpoint
ALTER TABLE `actor` ADD `github_login` text CONSTRAINT "actor_github_login_check" CHECK("github_login" is null or ("kind" = 'human' and length("github_login") between 1 and 39 and "github_login" not glob '*[^a-z0-9-]*' and "github_login" not glob '-*' and "github_login" not glob '*-' and "github_login" not glob '*--*'));--> statement-breakpoint
CREATE UNIQUE INDEX `actor_github_login_unique` ON `actor` (`github_login`) WHERE "github_login" is not null;