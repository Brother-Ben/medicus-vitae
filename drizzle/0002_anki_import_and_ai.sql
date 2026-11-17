CREATE TABLE `ai_provider` (
	`id` text PRIMARY KEY NOT NULL,
	`api_key` text,
	`model` text NOT NULL,
	`monthly_cap_usd` real,
	`input_price` real,
	`output_price` real,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `ai_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`feature` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`month` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_usage_month` ON `ai_usage` (`provider`,`month`);--> statement-breakpoint
CREATE TABLE `anki_import` (
	`id` text PRIMARY KEY NOT NULL,
	`file_name` text NOT NULL,
	`file_size` integer NOT NULL,
	`file_hash` text NOT NULL,
	`status` text NOT NULL,
	`progress` real DEFAULT 0 NOT NULL,
	`message` text DEFAULT '' NOT NULL,
	`analysis` text,
	`decisions` text,
	`result` text,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer
);
--> statement-breakpoint
CREATE TABLE `chat_message` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`role` text NOT NULL,
	`mode` text,
	`text` text NOT NULL,
	`status` text DEFAULT 'answered' NOT NULL,
	`citations` text DEFAULT '[]' NOT NULL,
	`claims` text DEFAULT '[]' NOT NULL,
	`provider` text,
	`model` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`thread_id`) REFERENCES `chat_thread`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_message_thread` ON `chat_message` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `chat_thread` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`mode` text DEFAULT 'guide' NOT NULL,
	`context` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE INDEX `chat_thread_updated` ON `chat_thread` (`updated_at`);--> statement-breakpoint
CREATE TABLE `generated_item` (
	`id` text PRIMARY KEY NOT NULL,
	`batch_id` text NOT NULL,
	`kind` text NOT NULL,
	`content` text NOT NULL,
	`sources` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`flagged` integer DEFAULT false NOT NULL,
	`checks` text,
	`document_id` text,
	`section_id` text,
	`aamc_code` text,
	`result_ref` text,
	`provider` text,
	`model` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `generated_item_status` ON `generated_item` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `generated_item_batch` ON `generated_item` (`batch_id`);--> statement-breakpoint
CREATE TABLE `media` (
	`name` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`ext` text NOT NULL,
	`size` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `annotation` ADD `origin` text DEFAULT 'owner' NOT NULL;--> statement-breakpoint
ALTER TABLE `card` ADD `deck` text;--> statement-breakpoint
ALTER TABLE `note` ADD `imported_rev` integer;--> statement-breakpoint
ALTER TABLE `note` ADD `imported_hash` text;--> statement-breakpoint
ALTER TABLE `note` ADD `import_id` text;--> statement-breakpoint
ALTER TABLE `note_type` ADD `css` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `note_type` ADD `source` text DEFAULT 'builtin' NOT NULL;--> statement-breakpoint
ALTER TABLE `note_type` ADD `sort_field` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `note_type` ADD `updated_at` integer;--> statement-breakpoint
ALTER TABLE `question` ADD `sources` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `question` ADD `document_id` text;--> statement-breakpoint
ALTER TABLE `user` ADD `leech_threshold` integer DEFAULT 8 NOT NULL;--> statement-breakpoint
ALTER TABLE `user` ADD `ai_provider` text;--> statement-breakpoint
-- Change counter for the new owner-data tables (see 0001).
CREATE TRIGGER `ws_ai_provider_i` AFTER INSERT ON `ai_provider` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_ai_provider_u` AFTER UPDATE ON `ai_provider` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_ai_provider_d` AFTER DELETE ON `ai_provider` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_ai_usage_i` AFTER INSERT ON `ai_usage` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_ai_usage_u` AFTER UPDATE ON `ai_usage` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_ai_usage_d` AFTER DELETE ON `ai_usage` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_anki_import_i` AFTER INSERT ON `anki_import` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_anki_import_u` AFTER UPDATE ON `anki_import` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_anki_import_d` AFTER DELETE ON `anki_import` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_chat_message_i` AFTER INSERT ON `chat_message` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_chat_message_u` AFTER UPDATE ON `chat_message` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_chat_message_d` AFTER DELETE ON `chat_message` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_chat_thread_i` AFTER INSERT ON `chat_thread` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_chat_thread_u` AFTER UPDATE ON `chat_thread` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_chat_thread_d` AFTER DELETE ON `chat_thread` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_generated_item_i` AFTER INSERT ON `generated_item` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_generated_item_u` AFTER UPDATE ON `generated_item` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_generated_item_d` AFTER DELETE ON `generated_item` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_media_i` AFTER INSERT ON `media` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_media_u` AFTER UPDATE ON `media` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_media_d` AFTER DELETE ON `media` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE INDEX `card_leech` ON `card` (`leech`) WHERE `leech` = 1;