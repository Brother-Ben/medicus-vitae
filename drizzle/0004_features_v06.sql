CREATE TABLE `ai_summary` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`scope` text DEFAULT '' NOT NULL,
	`text` text NOT NULL,
	`data` text,
	`provider` text,
	`model` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ai_summary_kind` ON `ai_summary` (`kind`,`created_at`);--> statement-breakpoint
CREATE TABLE `anki_push` (
	`event_id` text PRIMARY KEY NOT NULL,
	`revlog_id` integer NOT NULL,
	`pushed_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `anki_push_revlog` ON `anki_push` (`revlog_id`);--> statement-breakpoint
CREATE TABLE `anki_sync_deck` (
	`deck` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_revlog_id` integer DEFAULT 0 NOT NULL,
	`last_import_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `card_due_change` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`due` integer NOT NULL,
	`prev_due` integer NOT NULL,
	`source` text DEFAULT 'manual' NOT NULL,
	`changed_at` integer NOT NULL,
	`study_day` text NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `card`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `card_due_change_card` ON `card_due_change` (`card_id`,`changed_at`);--> statement-breakpoint
CREATE TABLE `note_link` (
	`id` text PRIMARY KEY NOT NULL,
	`notes_document_id` text NOT NULL,
	`notes_page_from` integer,
	`notes_page_to` integer,
	`book_document_id` text NOT NULL,
	`book_page_from` integer NOT NULL,
	`book_page_to` integer NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`notes_document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`book_document_id`) REFERENCES `document`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `note_link_book` ON `note_link` (`book_document_id`,`book_page_from`);--> statement-breakpoint
CREATE INDEX `note_link_notes` ON `note_link` (`notes_document_id`);--> statement-breakpoint
ALTER TABLE `card` ADD `anki_card_id` integer;--> statement-breakpoint
CREATE INDEX `card_anki` ON `card` (`anki_card_id`);--> statement-breakpoint
ALTER TABLE `document` ADD `role` text DEFAULT 'book' NOT NULL;--> statement-breakpoint
ALTER TABLE `note` ADD `anki_note_id` integer;--> statement-breakpoint
ALTER TABLE `note` ADD `anki_pushed_rev` integer;--> statement-breakpoint
ALTER TABLE `session_plan` ADD `title` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `session_plan` ADD `focus` text;--> statement-breakpoint
ALTER TABLE `session_plan` ADD `timer` text;--> statement-breakpoint
ALTER TABLE `user` ADD `study_prefs` text;
--> statement-breakpoint
-- Change counter for the new owner-data tables (see 0001).
CREATE TRIGGER `ws_ai_summary_i` AFTER INSERT ON `ai_summary` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_ai_summary_u` AFTER UPDATE ON `ai_summary` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_ai_summary_d` AFTER DELETE ON `ai_summary` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_anki_push_i` AFTER INSERT ON `anki_push` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_anki_push_u` AFTER UPDATE ON `anki_push` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_anki_push_d` AFTER DELETE ON `anki_push` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_anki_sync_deck_i` AFTER INSERT ON `anki_sync_deck` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_anki_sync_deck_u` AFTER UPDATE ON `anki_sync_deck` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_anki_sync_deck_d` AFTER DELETE ON `anki_sync_deck` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_card_due_change_i` AFTER INSERT ON `card_due_change` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_card_due_change_u` AFTER UPDATE ON `card_due_change` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_card_due_change_d` AFTER DELETE ON `card_due_change` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_note_link_i` AFTER INSERT ON `note_link` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_note_link_u` AFTER UPDATE ON `note_link` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;--> statement-breakpoint
CREATE TRIGGER `ws_note_link_d` AFTER DELETE ON `note_link` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;