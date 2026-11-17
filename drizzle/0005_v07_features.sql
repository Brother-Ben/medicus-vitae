CREATE TABLE `card_suspend_change` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`suspended` integer NOT NULL,
	`prev` integer NOT NULL,
	`source` text NOT NULL,
	`batch_id` text,
	`reason` text DEFAULT '' NOT NULL,
	`changed_at` integer NOT NULL,
	`anki_pushed_at` integer,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `card_suspend_change_card` ON `card_suspend_change` (`card_id`,`changed_at`);--> statement-breakpoint
CREATE INDEX `card_suspend_change_batch` ON `card_suspend_change` (`batch_id`);--> statement-breakpoint
CREATE INDEX `card_suspend_change_push` ON `card_suspend_change` (`anki_pushed_at`);--> statement-breakpoint
CREATE TABLE `cars_attempt` (
	`id` text PRIMARY KEY NOT NULL,
	`passage_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer NOT NULL,
	`seconds` integer NOT NULL,
	`reading_seconds` integer DEFAULT 0 NOT NULL,
	`correct` integer NOT NULL,
	`scored` integer NOT NULL,
	`total` integer NOT NULL,
	`answers` text NOT NULL,
	`study_day` text NOT NULL,
	`created_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`passage_id`) REFERENCES `cars_passage`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cars_attempt_passage` ON `cars_attempt` (`passage_id`);--> statement-breakpoint
CREATE INDEX `cars_attempt_day` ON `cars_attempt` (`study_day`);--> statement-breakpoint
CREATE TABLE `cars_passage` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_url` text DEFAULT '' NOT NULL,
	`source_key` text NOT NULL,
	`title` text NOT NULL,
	`published_on` text,
	`topic` text DEFAULT '' NOT NULL,
	`body` text NOT NULL,
	`word_count` integer DEFAULT 0 NOT NULL,
	`method` text DEFAULT 'imported' NOT NULL,
	`imported_day` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cars_passage_key` ON `cars_passage` (`source_key`);--> statement-breakpoint
CREATE INDEX `cars_passage_day` ON `cars_passage` (`imported_day`);--> statement-breakpoint
CREATE TABLE `cars_question` (
	`id` text PRIMARY KEY NOT NULL,
	`passage_id` text NOT NULL,
	`position` integer NOT NULL,
	`stem` text NOT NULL,
	`choices` text NOT NULL,
	`answer` integer,
	`explanation` text DEFAULT '' NOT NULL,
	`skill` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`passage_id`) REFERENCES `cars_passage`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `cars_question_passage` ON `cars_question` (`passage_id`,`position`);--> statement-breakpoint
CREATE TABLE `deck_book_link` (
	`id` text PRIMARY KEY NOT NULL,
	`deck` text NOT NULL,
	`document_id` text NOT NULL,
	`suspend_unread` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deck_book_link_doc` ON `deck_book_link` (`document_id`);--> statement-breakpoint
CREATE TABLE `deck_book_map` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target` text NOT NULL,
	`page_from` integer NOT NULL,
	`page_to` integer NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`link_id`) REFERENCES `deck_book_link`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `deck_book_map_link` ON `deck_book_map` (`link_id`);--> statement-breakpoint
CREATE TABLE `full_length_item` (
	`id` text PRIMARY KEY NOT NULL,
	`full_length_id` text NOT NULL,
	`section` text NOT NULL,
	`number` integer NOT NULL,
	`correct` integer,
	`your_answer` text,
	`correct_answer` text,
	`aamc_code` text,
	`skill_code` text,
	`topic` text DEFAULT '' NOT NULL,
	`seconds` integer,
	`flagged` integer DEFAULT false NOT NULL,
	`mistake_id` text,
	`note` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`full_length_id`) REFERENCES `full_length`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `full_length_item_fl` ON `full_length_item` (`full_length_id`,`section`,`number`);--> statement-breakpoint
ALTER TABLE `ai_provider` ADD `base_url` text;--> statement-breakpoint
ALTER TABLE `document` ADD `read_ranges` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `document` ADD `progress_at` integer;--> statement-breakpoint
ALTER TABLE `full_length` ADD `details` text;--> statement-breakpoint
ALTER TABLE `user` ADD `cars_prefs` text;
--> statement-breakpoint
-- Change counter for the new owner-data tables (see 0001).
CREATE TRIGGER `ws_card_suspend_change_i` AFTER INSERT ON `card_suspend_change` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_card_suspend_change_u` AFTER UPDATE ON `card_suspend_change` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_card_suspend_change_d` AFTER DELETE ON `card_suspend_change` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_deck_book_link_i` AFTER INSERT ON `deck_book_link` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_deck_book_link_u` AFTER UPDATE ON `deck_book_link` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_deck_book_link_d` AFTER DELETE ON `deck_book_link` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_deck_book_map_i` AFTER INSERT ON `deck_book_map` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_deck_book_map_u` AFTER UPDATE ON `deck_book_map` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_deck_book_map_d` AFTER DELETE ON `deck_book_map` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_full_length_item_i` AFTER INSERT ON `full_length_item` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_full_length_item_u` AFTER UPDATE ON `full_length_item` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_full_length_item_d` AFTER DELETE ON `full_length_item` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_cars_passage_i` AFTER INSERT ON `cars_passage` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_cars_passage_u` AFTER UPDATE ON `cars_passage` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_cars_passage_d` AFTER DELETE ON `cars_passage` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_cars_question_i` AFTER INSERT ON `cars_question` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_cars_question_u` AFTER UPDATE ON `cars_question` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_cars_question_d` AFTER DELETE ON `cars_question` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_cars_attempt_i` AFTER INSERT ON `cars_attempt` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_cars_attempt_u` AFTER UPDATE ON `cars_attempt` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_cars_attempt_d` AFTER DELETE ON `cars_attempt` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
