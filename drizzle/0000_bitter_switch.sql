CREATE TABLE `approvals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`goal_id` text,
	`decision_id` integer,
	`action` text NOT NULL,
	`risk_level` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`requested_at` text NOT NULL,
	`resolved_at` text,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `artifacts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`goal_id` text,
	`work_unit_id` text,
	`artifact_type` text,
	`path` text,
	`entity_id` text,
	`change_type` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`goal_id` text,
	`scope_type` text,
	`scope_id` text,
	`decision` text NOT NULL,
	`reason` text,
	`alternatives` text,
	`risk_level` text,
	`reversible` integer DEFAULT 1 NOT NULL,
	`executor` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`metadata` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `executions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`goal_id` text,
	`work_unit_id` text,
	`executor` text,
	`action_type` text,
	`command` text,
	`result` text,
	`exit_code` integer,
	`started_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `failure_solutions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`failure_id` integer NOT NULL,
	`solution` text NOT NULL,
	`successful` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`failure_id`) REFERENCES `failures`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `failures` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`goal_id` text,
	`work_unit_id` text,
	`failure_type` text,
	`error_message` text,
	`context` text,
	`resolved` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`resolved_at` text
);
--> statement-breakpoint
CREATE TABLE `goal_questions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`goal_id` text NOT NULL,
	`question` text NOT NULL,
	`answer` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` text NOT NULL,
	`answered_at` text,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `goal_requirements` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`goal_id` text NOT NULL,
	`requirement_type` text NOT NULL,
	`description` text NOT NULL,
	`priority` text DEFAULT 'required' NOT NULL,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`status_reason` text,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	`status` text DEFAULT 'DRAFT' NOT NULL,
	`autonomy_level` text DEFAULT 'full' NOT NULL,
	`clarification_status` text DEFAULT 'pending' NOT NULL,
	`risk_level` text,
	`complexity` text,
	`contract_snapshot` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`locked_at` text,
	`started_at` text,
	`completed_at` text
);
--> statement-breakpoint
CREATE TABLE `knowledge` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope_type` text NOT NULL,
	`scope_id` text,
	`category` text,
	`statement` text NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`source_type` text,
	`source_reference` text,
	`status` text DEFAULT 'active' NOT NULL,
	`superseded_by` integer,
	`created_at` text NOT NULL,
	`last_verified_at` text
);
--> statement-breakpoint
CREATE TABLE `learnings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`scope_type` text,
	`scope_id` text,
	`trigger` text,
	`learning` text NOT NULL,
	`usefulness_score` real DEFAULT 1 NOT NULL,
	`times_used` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text
);
--> statement-breakpoint
CREATE TABLE `observations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`goal_id` text,
	`work_unit_id` text,
	`scope_type` text,
	`scope_id` text,
	`observation` text NOT NULL,
	`confidence` real DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`root_path` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `relationships` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_id` text NOT NULL,
	`relationship_type` text NOT NULL,
	`target_id` text NOT NULL,
	`metadata` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`path` text,
	`remote_url` text,
	`default_branch` text,
	`language` text,
	`framework` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `verification_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`goal_id` text,
	`work_unit_id` text,
	`requirement_id` integer,
	`verification_type` text,
	`command` text,
	`expected_result` text,
	`actual_result` text,
	`passed` integer,
	`created_at` text NOT NULL,
	FOREIGN KEY (`requirement_id`) REFERENCES `goal_requirements`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `work_unit_dependencies` (
	`work_unit_id` text NOT NULL,
	`depends_on` text NOT NULL,
	PRIMARY KEY(`work_unit_id`, `depends_on`)
);
--> statement-breakpoint
CREATE TABLE `work_units` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`parent_id` text,
	`title` text NOT NULL,
	`description` text,
	`work_type` text,
	`complexity` text,
	`status` text DEFAULT 'PENDING' NOT NULL,
	`priority` integer DEFAULT 100 NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`started_at` text,
	`completed_at` text,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action
);
