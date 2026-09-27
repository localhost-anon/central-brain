CREATE TABLE `embeddings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text NOT NULL,
	`model` text NOT NULL,
	`content_hash` text NOT NULL,
	`vector` blob NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `embeddings_source_model` ON `embeddings` (`source_type`,`source_id`,`model`);--> statement-breakpoint
ALTER TABLE `observations` ADD `source_ref` text;