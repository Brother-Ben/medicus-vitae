CREATE TABLE `anchor` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`version_id` text NOT NULL,
	`page_number` integer NOT NULL,
	`kind` text NOT NULL,
	`rects` text NOT NULL,
	`text_start` integer,
	`text_end` integer,
	`exact` text DEFAULT '' NOT NULL,
	`prefix` text DEFAULT '' NOT NULL,
	`suffix` text DEFAULT '' NOT NULL,
	`section_title` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `anchor_doc_page` ON `anchor` (`document_id`,`page_number`);--> statement-breakpoint
CREATE TABLE `annotation` (
	`id` text PRIMARY KEY NOT NULL,
	`anchor_id` text,
	`document_id` text,
	`body` text NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`anchor_id`) REFERENCES `anchor`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `annotation_doc` ON `annotation` (`document_id`);--> statement-breakpoint
CREATE TABLE `annotation_revision` (
	`id` text PRIMARY KEY NOT NULL,
	`annotation_id` text NOT NULL,
	`rev` integer NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`annotation_id`) REFERENCES `annotation`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `annotation_revision_annotation` ON `annotation_revision` (`annotation_id`);--> statement-breakpoint
CREATE TABLE `attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text,
	`external_ref` text DEFAULT '' NOT NULL,
	`source` text NOT NULL,
	`attempt_number` integer DEFAULT 1 NOT NULL,
	`answer` text,
	`correct` integer NOT NULL,
	`confidence` text,
	`time_ms` integer,
	`aamc_code` text,
	`skill_code` text,
	`mistake_id` text,
	`attempted_at` integer NOT NULL,
	`study_day` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `question`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`mistake_id`) REFERENCES `mistake`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `attempt_mistake` ON `attempt` (`mistake_id`);--> statement-breakpoint
CREATE INDEX `attempt_day` ON `attempt` (`study_day`);--> statement-breakpoint
CREATE TABLE `card` (
	`id` text PRIMARY KEY NOT NULL,
	`note_id` text NOT NULL,
	`ord` integer DEFAULT 0 NOT NULL,
	`due` integer NOT NULL,
	`stability` real DEFAULT 0 NOT NULL,
	`difficulty` real DEFAULT 0 NOT NULL,
	`elapsed_days` integer DEFAULT 0 NOT NULL,
	`scheduled_days` integer DEFAULT 0 NOT NULL,
	`learning_steps` integer DEFAULT 0 NOT NULL,
	`reps` integer DEFAULT 0 NOT NULL,
	`lapses` integer DEFAULT 0 NOT NULL,
	`state` integer DEFAULT 0 NOT NULL,
	`last_review` integer,
	`rev` integer DEFAULT 0 NOT NULL,
	`suspended` integer DEFAULT false NOT NULL,
	`leech` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`note_id`) REFERENCES `note`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `card_due` ON `card` (`due`);--> statement-breakpoint
CREATE INDEX `card_note` ON `card` (`note_id`);--> statement-breakpoint
CREATE TABLE `doc_page` (
	`id` text PRIMARY KEY NOT NULL,
	`version_id` text NOT NULL,
	`page_number` integer NOT NULL,
	`width` real NOT NULL,
	`height` real NOT NULL,
	`text` text NOT NULL,
	`items` text NOT NULL,
	`provenance` text DEFAULT 'original' NOT NULL,
	FOREIGN KEY (`version_id`) REFERENCES `document_version`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `doc_page_version_page` ON `doc_page` (`version_id`,`page_number`);--> statement-breakpoint
CREATE TABLE `doc_section` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`title` text NOT NULL,
	`level` integer DEFAULT 0 NOT NULL,
	`position` integer NOT NULL,
	`page_start` integer NOT NULL,
	`page_end` integer NOT NULL,
	`aamc_codes` text DEFAULT '[]' NOT NULL,
	`suggested_codes` text DEFAULT '[]' NOT NULL,
	`confirmed` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `doc_section_doc` ON `doc_section` (`document_id`,`position`);--> statement-breakpoint
CREATE TABLE `document` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`kind` text DEFAULT 'pdf' NOT NULL,
	`file_hash` text NOT NULL,
	`file_name` text NOT NULL,
	`file_size` integer NOT NULL,
	`page_count` integer,
	`status` text DEFAULT 'queued' NOT NULL,
	`error` text,
	`notice` text,
	`current_version_id` text,
	`provenance` text DEFAULT 'original' NOT NULL,
	`license` text,
	`last_page` integer,
	`furthest_page` integer,
	`last_opened_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `document_version` (
	`id` text PRIMARY KEY NOT NULL,
	`document_id` text NOT NULL,
	`extraction_version` text NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`page_count` integer,
	`created_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `full_length` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`provider` text NOT NULL,
	`form` text DEFAULT '' NOT NULL,
	`total` integer,
	`cp` integer,
	`cars` integer,
	`bb` integer,
	`ps` integer,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `full_length_date` ON `full_length` (`date`);--> statement-breakpoint
CREATE TABLE `highlight` (
	`id` text PRIMARY KEY NOT NULL,
	`anchor_id` text NOT NULL,
	`document_id` text NOT NULL,
	`color` text DEFAULT 'yellow' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`anchor_id`) REFERENCES `anchor`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `highlight_doc` ON `highlight` (`document_id`);--> statement-breakpoint
CREATE TABLE `instance` (
	`id` integer PRIMARY KEY NOT NULL,
	`installation_id` text NOT NULL,
	`generation` integer DEFAULT 1 NOT NULL,
	`primary_host_id` text NOT NULL,
	`promoted_at` integer NOT NULL,
	`promoted_from` text,
	`peer_key` text NOT NULL,
	`write_seq` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE INDEX `job_status` ON `job` (`status`);--> statement-breakpoint
CREATE TABLE `mistake` (
	`id` text PRIMARY KEY NOT NULL,
	`source_type` text NOT NULL,
	`source_ref` text DEFAULT '' NOT NULL,
	`full_length_id` text,
	`practice_set_id` text,
	`card_id` text,
	`aamc_code` text,
	`skill_code` text,
	`reason` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`what_to_do` text DEFAULT '' NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`repair_explanation` text DEFAULT '' NOT NULL,
	`passage_revisited` integer DEFAULT false NOT NULL,
	`retest_due` text,
	`reopened_count` integer DEFAULT 0 NOT NULL,
	`resolved_at` integer,
	`study_day` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`full_length_id`) REFERENCES `full_length`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`practice_set_id`) REFERENCES `practice_set`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mistake_state` ON `mistake` (`state`);--> statement-breakpoint
CREATE INDEX `mistake_fl` ON `mistake` (`full_length_id`);--> statement-breakpoint
CREATE TABLE `mistake_event` (
	`id` text PRIMARY KEY NOT NULL,
	`mistake_id` text NOT NULL,
	`from_state` text,
	`to_state` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mistake_id`) REFERENCES `mistake`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mistake_event_mistake` ON `mistake_event` (`mistake_id`);--> statement-breakpoint
CREATE TABLE `mistake_link` (
	`id` text PRIMARY KEY NOT NULL,
	`mistake_id` text NOT NULL,
	`kind` text NOT NULL,
	`ref_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`mistake_id`) REFERENCES `mistake`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `mistake_link_mistake` ON `mistake_link` (`mistake_id`);--> statement-breakpoint
CREATE TABLE `note` (
	`id` text PRIMARY KEY NOT NULL,
	`note_type_id` text NOT NULL,
	`fields` text NOT NULL,
	`format` text DEFAULT 'markdown' NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`aamc_code` text,
	`anchor_id` text,
	`guid` text NOT NULL,
	`origin` text DEFAULT 'owner' NOT NULL,
	`rev` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`note_type_id`) REFERENCES `note_type`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`anchor_id`) REFERENCES `anchor`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `note_guid` ON `note` (`guid`);--> statement-breakpoint
CREATE INDEX `note_anchor` ON `note` (`anchor_id`);--> statement-breakpoint
CREATE TABLE `note_type` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`fields` text NOT NULL,
	`templates` text NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `practice_set` (
	`id` text PRIMARY KEY NOT NULL,
	`date` text NOT NULL,
	`source` text NOT NULL,
	`section` text,
	`aamc_code` text,
	`skill_code` text,
	`total` integer NOT NULL,
	`correct` integer NOT NULL,
	`minutes` integer,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `practice_set_date` ON `practice_set` (`date`);--> statement-breakpoint
CREATE TABLE `question` (
	`id` text PRIMARY KEY NOT NULL,
	`stem` text NOT NULL,
	`choices` text DEFAULT '[]' NOT NULL,
	`answer` text,
	`explanation` text,
	`origin` text DEFAULT 'owner' NOT NULL,
	`aamc_code` text,
	`skill_code` text,
	`anchor_id` text,
	`approval_status` text DEFAULT 'approved' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`anchor_id`) REFERENCES `anchor`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `recovery_code` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_event` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`rating` integer NOT NULL,
	`confidence` text,
	`reviewed_at` integer NOT NULL,
	`time_taken_ms` integer DEFAULT 0 NOT NULL,
	`device_id` text NOT NULL,
	`device_seq` integer NOT NULL,
	`base_rev` integer NOT NULL,
	`scheduler_config_id` text NOT NULL,
	`seed` text NOT NULL,
	`received_at` integer NOT NULL,
	`study_day` text NOT NULL,
	`prev_state` integer NOT NULL,
	`prev_due` integer NOT NULL,
	`next_state` integer NOT NULL,
	`next_due` integer NOT NULL,
	`next_stability` real NOT NULL,
	`next_difficulty` real NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`scheduler_config_id`) REFERENCES `scheduler_config`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `review_event_card` ON `review_event` (`card_id`,`reviewed_at`);--> statement-breakpoint
CREATE INDEX `review_event_day` ON `review_event` (`study_day`);--> statement-breakpoint
CREATE UNIQUE INDEX `review_event_device_seq` ON `review_event` (`device_id`,`device_seq`);--> statement-breakpoint
CREATE TABLE `scheduler_config` (
	`id` text PRIMARY KEY NOT NULL,
	`scheduler` text NOT NULL,
	`params` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `session_plan` (
	`id` text PRIMARY KEY NOT NULL,
	`budget_minutes` integer NOT NULL,
	`items` text NOT NULL,
	`status` text DEFAULT 'planned' NOT NULL,
	`study_day` text NOT NULL,
	`created_at` integer NOT NULL,
	`started_at` integer,
	`completed_at` integer
);
--> statement-breakpoint
CREATE TABLE `study_session` (
	`id` text PRIMARY KEY NOT NULL,
	`activity` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`seconds` integer NOT NULL,
	`study_day` text NOT NULL,
	`document_id` text,
	`device_id` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `study_session_day` ON `study_session` (`study_day`);--> statement-breakpoint
CREATE TABLE `tombstone` (
	`id` text PRIMARY KEY NOT NULL,
	`record_type` text NOT NULL,
	`record_id` text NOT NULL,
	`deleted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tombstone_record` ON `tombstone` (`record_type`,`record_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` integer PRIMARY KEY NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`password_hash` text NOT NULL,
	`totp_secret` text,
	`totp_enabled` integer DEFAULT false NOT NULL,
	`test_date` text,
	`goal_score` integer,
	`weekly_hours` real,
	`study_days` text DEFAULT '[1,2,3,4,5,6]' NOT NULL,
	`day_start_hour` integer DEFAULT 4 NOT NULL,
	`time_zone` text DEFAULT 'UTC' NOT NULL,
	`new_cards_per_day` integer DEFAULT 20 NOT NULL,
	`desired_retention` real DEFAULT 0.9 NOT NULL,
	`baseline` text,
	`onboarded_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
