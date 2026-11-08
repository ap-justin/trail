ALTER TABLE `issue` ADD `source_status` text CONSTRAINT "issue_source_status_check" CHECK(length("source_status") <= 200);
