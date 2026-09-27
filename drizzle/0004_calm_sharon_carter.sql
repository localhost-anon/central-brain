ALTER TABLE `goal_questions` ADD `materiality` text DEFAULT 'material' NOT NULL;--> statement-breakpoint
ALTER TABLE `goal_questions` ADD `source` text DEFAULT 'session' NOT NULL;--> statement-breakpoint
ALTER TABLE `goal_questions` ADD `check_key` text;--> statement-breakpoint
ALTER TABLE `goal_questions` ADD `requirement_id` integer;--> statement-breakpoint
ALTER TABLE `goal_questions` ADD `status_reason` text;--> statement-breakpoint
CREATE UNIQUE INDEX `goal_questions_goal_check` ON `goal_questions` (`goal_id`,`check_key`);