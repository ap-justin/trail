CREATE TABLE `github_pull_request` (
	`url` text PRIMARY KEY NOT NULL,
	`state` text,
	`checked_at` integer,
	`attempted_at` integer,
	`failures` integer DEFAULT 0 NOT NULL,
	`last_read_at` integer NOT NULL,
	CONSTRAINT "github_pull_request_url_check" CHECK("url" glob 'https://github.com/?*/?*/pull/[1-9]*' and length("url") - length(replace("url", '/', '')) = 6 and rtrim("url", '0123456789') glob '*/pull/' and "url" not glob ('*[?#' || char(9, 10, 13, 32) || ']*')),
	CONSTRAINT "github_pull_request_state_check" CHECK("state" in ('open', 'draft', 'merged', 'closed')),
	CONSTRAINT "github_pull_request_checked_check" CHECK(("state" is null) = ("checked_at" is null)),
	CONSTRAINT "github_pull_request_attempted_check" CHECK("attempted_at" is not null or ("checked_at" is null and "failures" = 0)),
	CONSTRAINT "github_pull_request_failures_check" CHECK("failures" >= 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `github_pull_request_last_read_idx` ON `github_pull_request` (`last_read_at`);