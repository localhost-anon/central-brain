CREATE TABLE `worker_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`ts` text NOT NULL,
	`kind` text NOT NULL,
	`summary` text NOT NULL,
	`detail` text,
	FOREIGN KEY (`run_id`) REFERENCES `worker_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `worker_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`session_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`cwd` text NOT NULL,
	`pid` integer,
	`exit_reason` text,
	`created_at` text NOT NULL,
	`started_at` text,
	`ended_at` text,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `approvals` ADD `run_id` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `request_id` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `tool_name` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `request_json` text;--> statement-breakpoint
ALTER TABLE `approvals` ADD `note` text;