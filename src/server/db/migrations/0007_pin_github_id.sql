ALTER TABLE `actor` ADD `is_owner` integer DEFAULT 0 NOT NULL CONSTRAINT "actor_is_owner_check" CHECK("is_owner" = 0 or ("is_owner" = 1 and "kind" = 'human'));--> statement-breakpoint
CREATE UNIQUE INDEX `actor_owner_unique` ON `actor` (`is_owner`) WHERE "is_owner" = 1;--> statement-breakpoint
ALTER TABLE `invite` ADD `github_id` integer;--> statement-breakpoint
CREATE UNIQUE INDEX `invite_github_id_unique` ON `invite` (`github_id`) WHERE "github_id" is not null;--> statement-breakpoint
CREATE TRIGGER `invite_github_id_pinned` BEFORE UPDATE OF `github_id` ON `invite`
WHEN old.`github_id` IS NOT NULL AND new.`github_id` IS NOT old.`github_id`
BEGIN
	SELECT RAISE(ABORT, 'invite.github_id is bound to the account that claimed it and cannot change');
END;
