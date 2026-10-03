CREATE TABLE `goal_principle_acks` (
	`goal_id` text NOT NULL,
	`knowledge_id` integer NOT NULL,
	`mode` text NOT NULL,
	`note` text NOT NULL,
	`decision_id` integer,
	`created_at` text NOT NULL,
	PRIMARY KEY(`goal_id`, `knowledge_id`),
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`knowledge_id`) REFERENCES `knowledge`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `goal_projects` (
	`goal_id` text NOT NULL,
	`project_id` text NOT NULL,
	PRIMARY KEY(`goal_id`, `project_id`),
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `work_unit_requirements` (
	`work_unit_id` text NOT NULL,
	`requirement_id` integer NOT NULL,
	PRIMARY KEY(`work_unit_id`, `requirement_id`),
	FOREIGN KEY (`work_unit_id`) REFERENCES `work_units`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`requirement_id`) REFERENCES `goal_requirements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `failure_solutions` ADD `verdict` text;--> statement-breakpoint
ALTER TABLE `failure_solutions` ADD `reproduction` text;--> statement-breakpoint
ALTER TABLE `failures` ADD `resolution_note` text;--> statement-breakpoint
ALTER TABLE `goal_questions` ADD `recommended` text;--> statement-breakpoint
ALTER TABLE `goal_requirements` ADD `verify_method` text;--> statement-breakpoint
ALTER TABLE `goal_requirements` ADD `coverage` text;--> statement-breakpoint
ALTER TABLE `goals` ADD `rules_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `goals` ADD `completion_mode` text;--> statement-breakpoint
ALTER TABLE `goals` ADD `converge_snapshot` text;--> statement-breakpoint
ALTER TABLE `verification_runs` ADD `verdict` text;