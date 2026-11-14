-- a column constraint, not drizzle-kit's rebuild of actor: ADD COLUMN can carry a CHECK, and every NULL passes it
ALTER TABLE `actor` ADD `title` text CONSTRAINT "actor_title_check" CHECK("title" is null or ("kind" = 'bot' and length("title") between 1 and 40 and "title" = trim("title")));
