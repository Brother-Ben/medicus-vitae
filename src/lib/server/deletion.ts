import { eq } from 'drizzle-orm';
import { kindForNoteType } from '../cards';
import { requestIndex } from './ai/indexer';
import { invoke } from './anki/connect';
import { deleteNote, indexNote } from './cards';
import { db, inTx, sqlite } from './db';
import { ankiSyncDeck, tombstone } from './db/schema';
import { uuidv7 } from './ids';
import { deleteDocumentRecords, getDocument, LibraryError } from './library';
import { createSnapshot } from './snapshots';

// Deleting whole books and decks, and putting deleted cards back (Undo).
// A snapshot is taken first, so even a deleted book can be brought back from
// Settings › Backups & sync. Cards are only marked deleted, so their Undo is
// instant; "also delete in Anki" goes through AnkiConnect when Anki is open.

export class DeleteError extends Error {}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);

function all<T>(q: string, ...p: unknown[]): T[] {
	return sqlite().prepare(q).all(...p) as T[];
}

export interface DeletedCards {
	noteIds: string[];
	cardIds: string[];
	/** When they were deleted (the same stamp on every row), so Undo restores exactly these. */
	at: number;
	/** A deleted deck that Anki sync was following: Undo turns its sync back on. */
	resyncDeck?: string | null;
}

/** What deleting a deck would remove. */
export function deckDeletePreview(deck: string) {
	const r = sqlite()
		.prepare(
			`SELECT count(*) AS cards, count(DISTINCT c.note_id) AS notes, sum(c.reps) AS reviews, sum(CASE WHEN c.anki_card_id > 0 THEN 1 ELSE 0 END) AS inAnki
			 FROM card c JOIN note n ON n.id = c.note_id
			 WHERE c.deleted_at IS NULL AND n.deleted_at IS NULL AND (c.deck = ? OR c.deck LIKE ? ESCAPE '\\')`
		)
		.get(deck, escapeLike(deck) + '::%') as { cards: number; notes: number; reviews: number | null; inAnki: number | null };
	const synced = !!db().select().from(ankiSyncDeck).where(eq(ankiSyncDeck.deck, deck.split('::')[0])).get()?.enabled;
	return { cards: r.cards, notes: r.notes, reviews: r.reviews ?? 0, inAnki: r.inAnki ?? 0, synced };
}

/**
 * Deletes a deck and its subdecks: every card in them, and each note whose cards
 * are all there. Review history is kept with the deleted cards (Undo brings it back).
 */
export async function deleteDeck(deck: string, opts: { alsoInAnki?: boolean } = {}) {
	const name = String(deck ?? '').trim();
	if (!name) throw new DeleteError('Choose a deck.');
	const snapshot = await createSnapshot('pre-delete');
	const cards = all<{ id: string; note_id: string; anki_card_id: number | null }>(
		`SELECT c.id, c.note_id, c.anki_card_id FROM card c JOIN note n ON n.id = c.note_id
		 WHERE c.deleted_at IS NULL AND n.deleted_at IS NULL AND (c.deck = ? OR c.deck LIKE ? ESCAPE '\\')`,
		name,
		escapeLike(name) + '::%'
	);
	if (!cards.length) throw new DeleteError('That deck has no cards.');
	const inDeck = new Set(cards.map((c) => c.id));
	const noteIds = [...new Set(cards.map((c) => c.note_id))];
	const at = Date.now();
	const syncRow = db().select().from(ankiSyncDeck).where(eq(ankiSyncDeck.deck, name)).get();
	const deleted: DeletedCards = { noteIds: [], cardIds: [], at, resyncDeck: syncRow?.enabled ? name : null };
	inTx(() => {
		for (const noteId of noteIds) {
			const siblings = all<{ id: string }>('SELECT id FROM card WHERE note_id = ? AND deleted_at IS NULL', noteId);
			if (siblings.every((s) => inDeck.has(s.id))) {
				deleteNote(noteId, at);
				deleted.noteIds.push(noteId);
				deleted.cardIds.push(...siblings.map((s) => s.id));
			} else {
				// The note also has cards in other decks: only this deck's cards go.
				for (const s of siblings.filter((x) => inDeck.has(x.id))) {
					sqlite().prepare('UPDATE card SET deleted_at = ?, updated_at = ? WHERE id = ?').run(at, at, s.id);
					db().insert(tombstone).values({ id: uuidv7(), recordType: 'card', recordId: s.id, deletedAt: at }).run();
					deleted.cardIds.push(s.id);
				}
			}
		}
		// Decks linked to books, and the sync's record of the deck (a deleted deck isn't synced), go with it.
		sqlite().prepare(`UPDATE deck_book_link SET deleted_at = ?, updated_at = ? WHERE deleted_at IS NULL AND (deck = ? OR deck LIKE ? ESCAPE '\\')`).run(at, at, name, escapeLike(name) + '::%');
		if (syncRow?.enabled) sqlite().prepare('UPDATE anki_sync_deck SET enabled = 0, updated_at = ? WHERE deck = ?').run(at, name);
	});
	let anki: { ok: boolean; message: string } | null = null;
	if (opts.alsoInAnki) {
		try {
			await invoke('deleteDecks', { decks: [name], cardsToo: true }, { timeoutMs: 60_000 });
			anki = { ok: true, message: 'Deleted in Anki too.' };
		} catch (err) {
			anki = { ok: false, message: `Deleted here, but not in Anki: ${(err as Error).message}` };
		}
	}
	requestIndex();
	return { deleted, snapshotId: snapshot.id, anki, cards: deleted.cardIds.length };
}

/** Deletes one card (Anki deletes notes: a note's reverse or other cloze cards go with it). */
export async function deleteCardNote(noteId: string, opts: { alsoInAnki?: boolean } = {}) {
	const n = sqlite().prepare('SELECT id, anki_note_id FROM note WHERE id = ? AND deleted_at IS NULL').get(noteId) as { id: string; anki_note_id: number | null } | undefined;
	if (!n) throw new DeleteError('Card not found.');
	const cardIds = all<{ id: string }>('SELECT id FROM card WHERE note_id = ? AND deleted_at IS NULL', noteId).map((c) => c.id);
	const at = Date.now();
	inTx(() => deleteNote(noteId, at));
	let anki: { ok: boolean; message: string } | null = null;
	if (opts.alsoInAnki && n.anki_note_id && n.anki_note_id > 0) {
		try {
			await invoke('deleteNotes', { notes: [n.anki_note_id] });
			anki = { ok: true, message: 'Deleted in Anki too.' };
		} catch (err) {
			anki = { ok: false, message: `Deleted here, but not in Anki: ${(err as Error).message}` };
		}
	}
	return { deleted: { noteIds: [noteId], cardIds, at } satisfies DeletedCards, anki };
}

/** Undo: brings back cards and notes deleted together (same stamp). Their reviews were never removed. */
export function restoreDeleted(input: DeletedCards) {
	const at = Math.floor(Number(input.at));
	const noteIds = (input.noteIds ?? []).map(String).slice(0, 100_000);
	const cardIds = (input.cardIds ?? []).map(String).slice(0, 200_000);
	let restored = 0;
	inTx(() => {
		for (const id of noteIds) {
			sqlite().prepare('UPDATE note SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at = ?').run(Date.now(), id, at);
			sqlite().prepare("DELETE FROM tombstone WHERE record_type = 'note' AND record_id = ?").run(id);
		}
		for (const id of cardIds) {
			const r = sqlite().prepare('UPDATE card SET deleted_at = NULL, updated_at = ? WHERE id = ? AND deleted_at = ?').run(Date.now(), id, at);
			restored += r.changes;
			sqlite().prepare("DELETE FROM tombstone WHERE record_type = 'card' AND record_id = ?").run(id);
		}
		for (const id of noteIds) {
			const n = sqlite().prepare('SELECT note_type_id, fields, anchor_id FROM note WHERE id = ? AND deleted_at IS NULL').get(id) as
				| { note_type_id: string; fields: string; anchor_id: string | null }
				| undefined;
			if (n) indexNote(id, kindForNoteType(n.note_type_id), JSON.parse(n.fields), n.anchor_id);
		}
		// Deck links deleted with the deck come back too, and so does its sync.
		sqlite().prepare('UPDATE deck_book_link SET deleted_at = NULL WHERE deleted_at = ?').run(at);
		if (input.resyncDeck) sqlite().prepare('UPDATE anki_sync_deck SET enabled = 1, updated_at = ? WHERE deck = ?').run(Date.now(), String(input.resyncDeck));
	});
	requestIndex();
	return { restored };
}

/** What deleting a book would remove. */
export function bookDeletePreview(id: string) {
	const doc = getDocument(id);
	if (!doc || doc.role !== 'book') throw new LibraryError('Book not found.');
	const one = (q: string) => (sqlite().prepare(q).get(id) as { n: number }).n;
	return {
		title: doc.title,
		highlights: one('SELECT count(*) AS n FROM highlight WHERE document_id = ? AND deleted_at IS NULL'),
		notes: one('SELECT count(*) AS n FROM annotation WHERE document_id = ? AND deleted_at IS NULL'),
		cards: one(
			`SELECT count(*) AS n FROM card c JOIN note n ON n.id = c.note_id JOIN anchor a ON a.id = n.anchor_id
			 WHERE a.document_id = ? AND c.deleted_at IS NULL AND n.deleted_at IS NULL`
		),
		links: one('SELECT count(*) AS n FROM deck_book_link WHERE document_id = ? AND deleted_at IS NULL')
	};
}

/**
 * Deletes a book: its pages, chapters, highlights, reading notes on it and deck
 * links. Cards made from it stay (they keep a copy of their passage) unless
 * `deleteCards`. A snapshot is taken first (it's what Undo restores).
 */
export async function deleteBook(id: string, opts: { deleteCards?: boolean } = {}) {
	const doc = getDocument(id);
	if (!doc || doc.role !== 'book') throw new LibraryError('Book not found.');
	const snapshot = await createSnapshot('pre-delete');
	let cardsDeleted = 0;
	inTx(() => {
		if (opts.deleteCards) {
			const notes = all<{ id: string }>(
				`SELECT DISTINCT n.id FROM note n JOIN anchor a ON a.id = n.anchor_id WHERE a.document_id = ? AND n.deleted_at IS NULL`,
				id
			);
			for (const n of notes) {
				cardsDeleted += (sqlite().prepare('SELECT count(*) AS n FROM card WHERE note_id = ? AND deleted_at IS NULL').get(n.id) as { n: number }).n;
				deleteNote(n.id);
			}
		}
		// Reading notes written on this book.
		sqlite().prepare('UPDATE annotation SET deleted_at = ?, updated_at = ? WHERE document_id = ? AND deleted_at IS NULL').run(Date.now(), Date.now(), id);
		sqlite().prepare("DELETE FROM search_index WHERE kind = 'annotation' AND doc_id = ?").run(id);
		deleteDocumentRecords([id]);
	});
	requestIndex();
	return { snapshotId: snapshot.id, cardsDeleted, title: doc.title };
}
