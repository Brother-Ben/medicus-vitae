-- Keyword search across book pages, annotations and cards (LIB-03). Stemmed English.
CREATE VIRTUAL TABLE `search_index` USING fts5(
	`body`,
	`kind` UNINDEXED,
	`ref_id` UNINDEXED,
	`doc_id` UNINDEXED,
	`page` UNINDEXED,
	tokenize = 'porter unicode61 remove_diacritics 2'
);
--> statement-breakpoint
-- Built-in Anki-compatible note types.
INSERT INTO `note_type` (`id`, `name`, `kind`, `fields`, `templates`, `builtin`, `created_at`) VALUES
	('nt-basic', 'Basic', 'basic', '["Front","Back"]', '[{"name":"Card 1","front":"{{Front}}","back":"{{FrontSide}}<hr id=answer>{{Back}}"}]', 1, 0),
	('nt-basic-reversed', 'Basic (and reversed card)', 'basic_reversed', '["Front","Back"]', '[{"name":"Card 1","front":"{{Front}}","back":"{{FrontSide}}<hr id=answer>{{Back}}"},{"name":"Card 2","front":"{{Back}}","back":"{{FrontSide}}<hr id=answer>{{Front}}"}]', 1, 0),
	('nt-cloze', 'Cloze', 'cloze', '["Text","Back Extra"]', '[{"name":"Cloze","front":"{{cloze:Text}}","back":"{{cloze:Text}}<br>{{Back Extra}}"}]', 1, 0);
--> statement-breakpoint
-- Change counter: every write to owner data bumps instance.write_seq, so snapshots
-- can be skipped when nothing changed and a returning device can tell whether it
-- holds changes its peer never saw (spec Section 11).
CREATE TRIGGER `ws_anchor_i` AFTER INSERT ON `anchor` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_anchor_u` AFTER UPDATE ON `anchor` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_anchor_d` AFTER DELETE ON `anchor` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_annotation_i` AFTER INSERT ON `annotation` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_annotation_u` AFTER UPDATE ON `annotation` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_annotation_d` AFTER DELETE ON `annotation` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_annotation_revision_i` AFTER INSERT ON `annotation_revision` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_annotation_revision_u` AFTER UPDATE ON `annotation_revision` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_annotation_revision_d` AFTER DELETE ON `annotation_revision` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_attempt_i` AFTER INSERT ON `attempt` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_attempt_u` AFTER UPDATE ON `attempt` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_attempt_d` AFTER DELETE ON `attempt` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_card_i` AFTER INSERT ON `card` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_card_u` AFTER UPDATE ON `card` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_card_d` AFTER DELETE ON `card` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_doc_page_i` AFTER INSERT ON `doc_page` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_doc_page_u` AFTER UPDATE ON `doc_page` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_doc_page_d` AFTER DELETE ON `doc_page` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_doc_section_i` AFTER INSERT ON `doc_section` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_doc_section_u` AFTER UPDATE ON `doc_section` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_doc_section_d` AFTER DELETE ON `doc_section` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_document_i` AFTER INSERT ON `document` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_document_u` AFTER UPDATE ON `document` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_document_d` AFTER DELETE ON `document` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_document_version_i` AFTER INSERT ON `document_version` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_document_version_u` AFTER UPDATE ON `document_version` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_document_version_d` AFTER DELETE ON `document_version` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_full_length_i` AFTER INSERT ON `full_length` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_full_length_u` AFTER UPDATE ON `full_length` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_full_length_d` AFTER DELETE ON `full_length` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_highlight_i` AFTER INSERT ON `highlight` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_highlight_u` AFTER UPDATE ON `highlight` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_highlight_d` AFTER DELETE ON `highlight` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_job_i` AFTER INSERT ON `job` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_job_u` AFTER UPDATE ON `job` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_job_d` AFTER DELETE ON `job` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_mistake_i` AFTER INSERT ON `mistake` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_mistake_u` AFTER UPDATE ON `mistake` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_mistake_d` AFTER DELETE ON `mistake` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_mistake_event_i` AFTER INSERT ON `mistake_event` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_mistake_event_u` AFTER UPDATE ON `mistake_event` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_mistake_event_d` AFTER DELETE ON `mistake_event` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_mistake_link_i` AFTER INSERT ON `mistake_link` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_mistake_link_u` AFTER UPDATE ON `mistake_link` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_mistake_link_d` AFTER DELETE ON `mistake_link` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_note_i` AFTER INSERT ON `note` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_note_u` AFTER UPDATE ON `note` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_note_d` AFTER DELETE ON `note` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_note_type_i` AFTER INSERT ON `note_type` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_note_type_u` AFTER UPDATE ON `note_type` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_note_type_d` AFTER DELETE ON `note_type` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_practice_set_i` AFTER INSERT ON `practice_set` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_practice_set_u` AFTER UPDATE ON `practice_set` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_practice_set_d` AFTER DELETE ON `practice_set` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_question_i` AFTER INSERT ON `question` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_question_u` AFTER UPDATE ON `question` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_question_d` AFTER DELETE ON `question` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_recovery_code_i` AFTER INSERT ON `recovery_code` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_recovery_code_u` AFTER UPDATE ON `recovery_code` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_recovery_code_d` AFTER DELETE ON `recovery_code` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_review_event_i` AFTER INSERT ON `review_event` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_review_event_u` AFTER UPDATE ON `review_event` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_review_event_d` AFTER DELETE ON `review_event` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_scheduler_config_i` AFTER INSERT ON `scheduler_config` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_scheduler_config_u` AFTER UPDATE ON `scheduler_config` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_scheduler_config_d` AFTER DELETE ON `scheduler_config` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_session_plan_i` AFTER INSERT ON `session_plan` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_session_plan_u` AFTER UPDATE ON `session_plan` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_session_plan_d` AFTER DELETE ON `session_plan` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_study_session_i` AFTER INSERT ON `study_session` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_study_session_u` AFTER UPDATE ON `study_session` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_study_session_d` AFTER DELETE ON `study_session` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_tombstone_i` AFTER INSERT ON `tombstone` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_tombstone_u` AFTER UPDATE ON `tombstone` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_tombstone_d` AFTER DELETE ON `tombstone` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_user_i` AFTER INSERT ON `user` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_user_u` AFTER UPDATE ON `user` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
--> statement-breakpoint
CREATE TRIGGER `ws_user_d` AFTER DELETE ON `user` BEGIN UPDATE `instance` SET `write_seq` = `write_seq` + 1; END;
