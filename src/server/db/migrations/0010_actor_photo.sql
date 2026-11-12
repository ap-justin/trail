CREATE TABLE `actor_photo` (
	`actor_id` text PRIMARY KEY NOT NULL,
	`content_type` text NOT NULL,
	`hash` text NOT NULL,
	`updated_at` integer NOT NULL,
	`content` blob NOT NULL,
	FOREIGN KEY (`actor_id`) REFERENCES `actor`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "actor_photo_content_type_check" CHECK("content_type" in ('image/png', 'image/jpeg', 'image/webp')),
	CONSTRAINT "actor_photo_content_check" CHECK(length("content") between 1 and 262144),
	CONSTRAINT "actor_photo_hash_check" CHECK(length("hash") = 64 and "hash" not glob '*[^0-9a-f]*')
) STRICT;
