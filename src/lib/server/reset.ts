import { forgetChatgpt } from './ai/chatgpt';
import { forgetClaudeCode } from './ai/claude-code';
import { requestIndex } from './ai/indexer';
import { deleteAllSessions } from './auth';
import { inTx, kvDelete, sqlite } from './db';
import { deleteDocumentRecords } from './library';
import { createSnapshot, type SnapshotMeta } from './snapshots';

// "Reset data" (Settings › Data): wipes the parts the owner picks and leaves the
// rest. A snapshot is taken first, so a reset can be undone from Backups & sync
// (or the Undo button right after). Book files stay in the data folder, since
// that snapshot still points at them.

export const RESET_PARTS = [
	{ id: 'books', name: 'Books and reading', detail: 'Your books, highlights, where you stopped reading, and links from notes to book pages.' },
	{ id: 'cards', name: 'Flashcards', detail: 'Every card and deck, all review history, Anki imports and Anki sync links.' },
	{ id: 'notes', name: 'Notes', detail: 'Reading notes and the notes PDFs you uploaded.' },
	{ id: 'practice', name: 'Mistakes and practice', detail: 'The mistake journal, practice sets, full-length scores, CARS passages and quiz questions.' },
	{ id: 'history', name: 'Study history', detail: 'Study time, streak, planned sessions and AI summaries on Today.' },
	{ id: 'tutor', name: 'Tutor', detail: 'Tutor conversations, AI-made items waiting for approval, and AI usage records.' },
	{ id: 'settings', name: 'Settings', detail: 'Goals, test date, card limits, focus timer, appearance. You’ll see the welcome steps again.' }
] as const;

export type ResetPart = (typeof RESET_PARTS)[number]['id'];

export class ResetError extends Error {}

function run(sql: string, ...params: unknown[]) {
	sqlite().prepare(sql).run(...params);
}

function idsOf(sql: string, ...params: unknown[]): string[] {
	return (sqlite().prepare(sql).all(...params) as { id: string }[]).map((r) => r.id);
}

const deleteDocuments = deleteDocumentRecords;

function resetCards(keepPractice: boolean) {
	if (keepPractice) {
		run('UPDATE mistake SET card_id = NULL WHERE card_id IS NOT NULL');
		run("DELETE FROM mistake_link WHERE kind = 'card'");
	}
	run('DELETE FROM card_due_change');
	run('DELETE FROM card_suspend_change');
	run('DELETE FROM deck_book_map');
	run('DELETE FROM deck_book_link');
	run('DELETE FROM anki_push');
	run('DELETE FROM review_event');
	run('DELETE FROM card');
	run('DELETE FROM note');
	run("DELETE FROM search_index WHERE kind = 'card'");
	run('DELETE FROM note_type WHERE builtin = 0');
	run('DELETE FROM media');
	run('DELETE FROM anki_import');
	run('DELETE FROM anki_sync_deck');
	run("DELETE FROM job WHERE type LIKE 'anki%'");
}

function resetNotes() {
	run('DELETE FROM annotation_revision');
	run('DELETE FROM annotation');
	run("DELETE FROM search_index WHERE kind = 'annotation'");
	deleteDocuments(idsOf("SELECT id FROM document WHERE role = 'notes'"));
	run('DELETE FROM note_link');
}

function resetPractice() {
	run('DELETE FROM attempt');
	run('DELETE FROM mistake_event');
	run('DELETE FROM mistake_link');
	run('DELETE FROM mistake');
	run('DELETE FROM practice_set');
	run('DELETE FROM full_length_item');
	run('DELETE FROM full_length');
	run('DELETE FROM question');
	run('DELETE FROM cars_attempt');
	run('DELETE FROM cars_question');
	run('DELETE FROM cars_passage');
}

function resetSettings() {
	run(
		`UPDATE user SET display_name = '', test_date = NULL, goal_score = NULL, weekly_hours = NULL, study_days = '[1,2,3,4,5,6]',
		 day_start_hour = 4, new_cards_per_day = 20, desired_retention = 0.9, leech_threshold = 8, baseline = NULL,
		 appearance = NULL, study_prefs = NULL, cars_prefs = NULL, onboarded_at = NULL, guide_done_at = NULL, updated_at = ? WHERE id = 1`,
		Date.now()
	);
}

export interface ResetResult {
	parts: ResetPart[] | 'everything';
	snapshotId: string;
}

/**
 * Wipes the chosen parts. `everything` goes back to the first-run setup screen
 * (sign-in, AI connections and every setting included). The snapshot taken first
 * is returned so the owner can undo it.
 */
export async function resetData(choice: ResetPart[] | 'everything', opts: { snapshot?: boolean } = {}): Promise<ResetResult> {
	const all = choice === 'everything';
	const parts = new Set<ResetPart>(all ? RESET_PARTS.map((p) => p.id) : choice);
	if (!parts.size) throw new ResetError('Choose at least one thing to reset.');
	let meta: SnapshotMeta | null = null;
	if (opts.snapshot !== false) meta = await createSnapshot('pre-reset');

	inTx(() => {
		if (parts.has('practice')) resetPractice();
		if (parts.has('cards')) resetCards(!parts.has('practice'));
		if (parts.has('notes')) resetNotes();
		if (parts.has('books')) {
			deleteDocuments(idsOf("SELECT id FROM document WHERE role = 'book'"));
			run('DELETE FROM highlight');
		}
		if (parts.has('history')) {
			run('DELETE FROM study_session');
			run('DELETE FROM session_plan');
			run('DELETE FROM ai_summary');
		}
		if (parts.has('tutor')) {
			run('DELETE FROM chat_message');
			run('DELETE FROM chat_thread');
			run('DELETE FROM generated_item');
			run('DELETE FROM ai_usage');
		}
		if (parts.has('settings')) resetSettings();
		if (all) {
			run('DELETE FROM job');
			run('DELETE FROM tombstone');
			run('DELETE FROM search_index');
			run('DELETE FROM anchor');
			run('DELETE FROM ai_provider');
			run('DELETE FROM recovery_code');
			run('DELETE FROM user');
		}
	});
	if (all) {
		deleteAllSessions();
		// This device's own connections (ChatGPT sign-in, Claude Code account, Anki).
		try {
			forgetChatgpt();
		} catch {
			// not signed in
		}
		forgetClaudeCode();
		kvDelete('anki_connect');
		kvDelete('ai_quality_last');
	}
	// The tutor's search index notices removed books, notes and cards on its next pass.
	requestIndex();
	return { parts: all ? 'everything' : [...parts], snapshotId: meta?.id ?? '' };
}
