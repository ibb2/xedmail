CREATE TABLE `mailboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email_address` text NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text,
	`access_token_expires_at` integer,
	`is_active` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sender_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`address` text NOT NULL,
	`rule` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sender_rules_user_id_address_unique` ON `sender_rules` (`user_id`,`address`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`user_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_state` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`email_id` text NOT NULL,
	`is_archived` integer DEFAULT false NOT NULL,
	`snoozed_until` integer,
	`is_replied` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_state_user_id_email_id_unique` ON `user_state` (`user_id`,`email_id`);