import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Grade } from 'ts-fsrs';
import { CARS_SKILL_CODES, isCategoryCode } from '../aamc';
import {
	cardOrds,
	cardSides,
	kindForNoteType,
	noteProblem,
	notePreview,
	noteText,
	noteTypeId,
	type Confidence,
	type NoteKind,
	type OwnNoteKind
} from '../cards';
import { addDays, diffDays, intervalLabel, studyDayOf, studyDayStart } from '../dates';
import { renderCardSide } from '../markdown';
import { clozeNumbersIn } from './anki/cloze';
import { mediaBase } from './anki/media';
import { renderAnkiCard, type AnkiNoteTypeShape } from './anki/template';
import { db, inTx, sqlite } from './db';
import { anchor, card, cardDueChange, note, noteType, reviewEvent, tombstone } from './db/schema';
import {
	applyDueChange,
	applyRating,
	currentParams,
	emptyState,
	ensureSchedulerConfig,
	loadSchedulerParams,
	previewDue,
	replay,
	sameState,
	schedState,
	type CardRow
} from './fsrs';
import { noteGuid, uuidv7, uuidv7At } from './ids';
import { anchorLabel, anchorView, anchorViews, createAnchor, type AnchorInput, type AnchorView } from './reading';
import { indexEntry, unindexEntry } from './search';
import { studyClock, studySettings, type StudyClock } from './settings';
import { changeSuspension } from './suspend';

export class CardError extends Error {}

const LEARN_AHEAD_MS = 20 * 60_000;
const FIELD_MAX = 20_000;

export interface NoteInput {
	kind: NoteKind;
	fields: Record<string, string>;
	aamcCode?: string | null;
	tags?: string[];
}

function cleanFields(kind: NoteKind, fields: Record<string, string>, ankiFieldNames: string[] = []) {
	if (kind === 'anki') {
		// Anki notes keep their HTML; only the note type's own fields are kept.
		const out: Record<string, string> = {};
		for (const name of ankiFieldNames) {
			const v = String(fields?.[name] ?? '');
			if (v.length > FIELD_MAX * 5) throw new CardError(`${name} is too long.`);
			out[name] = v;
		}
		return out;
	}
	const names = kind === 'cloze' ? ['Text', 'Back Extra'] : ['Front', 'Back'];
	const out: Record<string, string> = {};
	for (const name of names) {
		const v = String(fields?.[name] ?? '').replace(/\r\n/g, '\n');
		if (v.length > FIELD_MAX) throw new CardError(`${name} is too long.`);
		out[name] = v.trim();
	}
	return out;
}

function cleanCode(code: string | null | undefined) {
	if (!code) return null;
	return isCategoryCode(code) || CARS_SKILL_CODES.includes(code) ? code : null;
}

function cleanTags(tags: string[] | undefined) {
	return [
		...new Set(
			(tags ?? [])
				.map((t) => String(t).trim().replace(/\s+/g, '_').slice(0, 60))
				.filter(Boolean)
		)
	].slice(0, 30);
}

function ankiClozeNumbers(values: string[]) {
	const set = new Set<number>();
	for (const v of values) for (const n of clozeNumbersIn(v)) set.add(n);
	return set;
}

export function indexNote(noteId: string, kind: NoteKind, fields: Record<string, string>, anchorId: string | null) {
	let docId: string | null = null;
	let page: number | null = null;
	if (anchorId) {
		const a = db().select().from(anchor).where(eq(anchor.id, anchorId)).get();
		docId = a?.documentId ?? null;
		page = a?.pageNumber ?? null;
	}
	indexEntry(sqlite(), { kind: 'card', refId: noteId, body: noteText(kind, fields), docId, page });
}

/** Creates a note and its cards. All new cards start due now, in FSRS "New" state. */
export function createNote(input: NoteInput & { anchorId?: string | null; origin?: string }) {
	if (input.kind === 'anki' || !['basic', 'basic_reversed', 'cloze'].includes(input.kind)) throw new CardError('Unknown card type.');
	const kind: OwnNoteKind = input.kind;
	const fields = cleanFields(kind, input.fields);
	const problem = noteProblem(input.kind, fields);
	if (problem) throw new CardError(problem);
	const now = Date.now();
	const noteId = uuidv7();
	const ords = cardOrds(input.kind, fields);
	const cardIds: string[] = [];
	inTx(() => {
		db()
			.insert(note)
			.values({
				id: noteId,
				noteTypeId: noteTypeId(kind),
				fields,
				format: 'markdown',
				tags: cleanTags(input.tags),
				aamcCode: cleanCode(input.aamcCode),
				anchorId: input.anchorId ?? null,
				guid: noteGuid(),
				origin: input.origin ?? 'owner',
				rev: 1,
				createdAt: now,
				updatedAt: now
			})
			.run();
		for (const ord of ords) {
			const id = uuidv7();
			cardIds.push(id);
			db()
				.insert(card)
				.values({ id, noteId, ord, ...emptyState(now), rev: 0, createdAt: now, updatedAt: now })
				.run();
		}
		indexNote(noteId, input.kind, fields, input.anchorId ?? null);
	});
	return { noteId, cardIds };
}

export interface TemplatedNoteInput {
	noteTypeId: string;
	fields: Record<string, string>;
	aamcCode?: string | null;
	tags?: string[];
	anchorId?: string | null;
	origin?: string;
}

/**
 * A note of a card type with its own templates (made here, imported from Anki,
 * or Image Occlusion): HTML fields, and a card per template that shows something
 * (or per cloze number).
 */
export function createTemplatedNote(input: TemplatedNoteInput) {
	const t = getNoteType(input.noteTypeId);
	if (!t || kindForNoteType(t.id) !== 'anki') throw new CardError('Unknown card type.');
	const fields = cleanFields('anki', input.fields, t.fields);
	const problem = noteProblem('anki', fields);
	if (problem) throw new CardError(problem);
	const tags = [...new Set((input.tags ?? []).map((x) => String(x).trim().replace(/\s+/g, '_')).filter(Boolean))].slice(0, 60);
	const shape = ankiShape(t);
	let ords: number[];
	if (shape.kind === 'cloze') {
		ords = [...ankiClozeNumbers(Object.values(fields))].sort((a, b) => a - b).map((n) => n - 1);
		if (!ords.length) throw new CardError('Mark at least one deletion, like {{c1::answer}} (or draw a mask for image occlusion).');
	} else {
		ords = shape.templates.map((_t, i) => i).filter((i) => !renderAnkiCard(shape, fields, i, { tags, deck: null }).empty);
		if (!ords.length) throw new CardError('Fill in the fields this card type’s front shows.');
	}
	const now = Date.now();
	const noteId = uuidv7();
	const cardIds: string[] = [];
	inTx(() => {
		db()
			.insert(note)
			.values({ id: noteId, noteTypeId: t.id, fields, format: 'html', tags, aamcCode: cleanCode(input.aamcCode), anchorId: input.anchorId ?? null, guid: noteGuid(), origin: input.origin ?? 'owner', rev: 1, createdAt: now, updatedAt: now })
			.run();
		for (const ord of ords) {
			const id = uuidv7();
			cardIds.push(id);
			db().insert(card).values({ id, noteId, ord, ...emptyState(now), rev: 0, createdAt: now, updatedAt: now }).run();
		}
		indexNote(noteId, 'anki', fields, input.anchorId ?? null);
	});
	return { noteId, cardIds };
}

/** Highlight → card: the anchor and the card are saved together, or not at all. */
export function createNoteFromSelection(anchorInput: AnchorInput, input: NoteInput) {
	return inTx(() => {
		const anchorId = createAnchor(anchorInput);
		return { anchorId, ...createNote({ ...input, anchorId }) };
	});
}

export function createTemplatedNoteFromSelection(anchorInput: AnchorInput, input: TemplatedNoteInput) {
	return inTx(() => {
		const anchorId = createAnchor(anchorInput);
		return { anchorId, ...createTemplatedNote({ ...input, anchorId }) };
	});
}

export function getNote(noteId: string) {
	const n = db().select().from(note).where(eq(note.id, noteId)).get();
	if (!n || n.deletedAt) return null;
	return n;
}

export function getNoteType(id: string) {
	return db().select().from(noteType).where(eq(noteType.id, id)).get() ?? null;
}

export function updateNote(noteId: string, input: NoteInput) {
	const current = getNote(noteId);
	if (!current) throw new CardError('Card not found.');
	const kind = kindForNoteType(current.noteTypeId);
	const type = kind === 'anki' ? getNoteType(current.noteTypeId) : null;
	const fields = cleanFields(kind, input.fields, type?.fields ?? []);
	const problem = noteProblem(kind, fields);
	if (problem) throw new CardError(problem);
	const now = Date.now();
	const isCloze = kind === 'cloze' || type?.kind === 'anki_cloze';
	inTx(() => {
		const tx = db();
		tx.update(note)
			.set({
				fields,
				aamcCode: cleanCode(input.aamcCode),
				// Anki tags may contain "::" hierarchies; keep them as they are.
				tags: kind === 'anki' ? [...new Set((input.tags ?? []).map((t) => String(t).trim()).filter(Boolean))].slice(0, 200) : cleanTags(input.tags),
				rev: current.rev + 1,
				updatedAt: now
			})
			.where(eq(note.id, noteId))
			.run();
		if (isCloze) {
			// Keep cards for cloze numbers that remain, add new ones, retire removed ones.
			const wanted = new Set(
				kind === 'anki' ? [...ankiClozeNumbers(Object.values(fields))].map((n) => n - 1) : cardOrds(kind, fields)
			);
			const existing = tx
				.select()
				.from(card)
				.where(and(eq(card.noteId, noteId), isNull(card.deletedAt)))
				.all();
			const have = new Set(existing.map((c) => c.ord));
			const deck = existing.find((c) => c.deck)?.deck ?? null;
			for (const ord of wanted) {
				if (!have.has(ord)) {
					tx.insert(card)
						.values({ id: uuidv7(), noteId, ord, ...emptyState(now), rev: 0, deck, createdAt: now, updatedAt: now })
						.run();
				}
			}
			for (const c of existing) {
				if (!wanted.has(c.ord)) {
					tx.update(card).set({ deletedAt: now, updatedAt: now }).where(eq(card.id, c.id)).run();
					tx.insert(tombstone).values({ id: uuidv7(), recordType: 'card', recordId: c.id, deletedAt: now }).run();
				}
			}
		} else if (kind === 'anki' && type && type.source !== 'anki') {
			// A card type with several templates: a field filled in can make another card show something (as in Anki).
			const shape = ankiShape(type);
			const existing = tx.select().from(card).where(and(eq(card.noteId, noteId), isNull(card.deletedAt))).all();
			const have = new Set(existing.map((c) => c.ord));
			const deck = existing.find((c) => c.deck)?.deck ?? null;
			shape.templates.forEach((_t, ord) => {
				if (have.has(ord) || renderAnkiCard(shape, fields, ord, { tags: current.tags, deck }).empty) return;
				tx.insert(card).values({ id: uuidv7(), noteId, ord, ...emptyState(now), rev: 0, deck, createdAt: now, updatedAt: now }).run();
			});
		}
		indexNote(noteId, kind, fields, current.anchorId);
	});
}

/** Marks a note and its cards deleted (reviews are kept). `now` lets several deletions share one stamp for Undo. */
export function deleteNote(noteId: string, now = Date.now()) {
	const current = getNote(noteId);
	if (!current) return;
	db().transaction((tx) => {
		tx.update(note).set({ deletedAt: now, updatedAt: now }).where(eq(note.id, noteId)).run();
		const cards = tx.select().from(card).where(eq(card.noteId, noteId)).all();
		for (const c of cards) {
			if (c.deletedAt) continue;
			tx.update(card).set({ deletedAt: now, updatedAt: now }).where(eq(card.id, c.id)).run();
			tx.insert(tombstone).values({ id: uuidv7(), recordType: 'card', recordId: c.id, deletedAt: now }).run();
		}
		tx.insert(tombstone).values({ id: uuidv7(), recordType: 'note', recordId: noteId, deletedAt: now }).run();
		unindexEntry(sqlite(), 'card', noteId);
	});
}

/** Suspends or unsuspends by hand (logged, so a linked book never undoes it, and sent to Anki by the sync). */
export function setSuspended(cardIds: string | string[], suspended: boolean) {
	return changeSuspension(Array.isArray(cardIds) ? cardIds : [cardIds], suspended, { source: 'manual', reason: suspended ? 'Suspended by hand' : 'Unsuspended by hand' });
}

// ----------------------------------------------------------- the queue

/** Cards eligible for study: not deleted, not suspended, note not deleted. */
const ACTIVE = 'c.deleted_at IS NULL AND c.suspended = 0 AND n.deleted_at IS NULL';

function newIntroducedToday(clock: StudyClock) {
	return (
		sqlite()
			.prepare(`SELECT count(DISTINCT card_id) AS n FROM review_event WHERE study_day = ? AND prev_state = 0`)
			.get(clock.today) as { n: number }
	).n;
}

export interface QueueCounts {
	learning: number;
	review: number;
	new: number;
	total: number;
	newLimitLeft: number;
}

export interface QueueFilter {
	aamcCode?: string | null;
	documentId?: string | null;
	/** An Anki deck (and its subdecks). */
	deck?: string | null;
	/** Only cards that are due (no new ones), or only new cards (plus their learning steps). */
	only?: 'due' | 'new' | null;
}

function escapeLike(s: string) {
	return s.replace(/[\\%_]/g, (x) => '\\' + x);
}

/** SQL conditions (each starting with AND) for a study filter, with their parameters. */
function filterSql(filter: QueueFilter): { sql: string; params: unknown[] } {
	const parts: string[] = [];
	const params: unknown[] = [];
	if (filter.aamcCode) {
		parts.push('AND n.aamc_code = ?');
		params.push(filter.aamcCode);
	}
	if (filter.documentId) {
		parts.push('AND n.anchor_id IN (SELECT id FROM anchor WHERE document_id = ?)');
		params.push(filter.documentId);
	}
	if (filter.deck) {
		parts.push("AND (c.deck = ? OR c.deck LIKE ? ESCAPE '\\')");
		params.push(filter.deck, escapeLike(filter.deck) + '::%');
	}
	return { sql: parts.join(' '), params };
}

export function queueCounts(clock: StudyClock = studyClock(), filter: QueueFilter = {}): QueueCounts {
	const s = studySettings();
	const conn = sqlite();
	const f = filterSql(filter);
	const learning = (
		conn
			.prepare(`SELECT count(*) AS n FROM card c JOIN note n ON n.id = c.note_id WHERE ${ACTIVE} ${f.sql} AND c.state IN (1, 3) AND c.due <= ?`)
			.get(...f.params, clock.now + LEARN_AHEAD_MS) as { n: number }
	).n;
	const review = (
		conn
			.prepare(`SELECT count(*) AS n FROM card c JOIN note n ON n.id = c.note_id WHERE ${ACTIVE} ${f.sql} AND c.state = 2 AND c.due < ?`)
			.get(...f.params, clock.dayEnd) as { n: number }
	).n;
	// A new card given a later start date (Set due date) waits until that day.
	const available = (
		conn
			.prepare(`SELECT count(*) AS n FROM card c JOIN note n ON n.id = c.note_id WHERE ${ACTIVE} ${f.sql} AND c.state = 0 AND c.due < ?`)
			.get(...f.params, clock.dayEnd) as { n: number }
	).n;
	const newLimitLeft = Math.max(0, s.newCardsPerDay - newIntroducedToday(clock));
	const fresh = filter.only === 'due' ? 0 : Math.min(available, newLimitLeft);
	const rev = filter.only === 'new' ? 0 : review;
	return { learning, review: rev, new: fresh, total: learning + rev + fresh, newLimitLeft };
}

/** Learning cards due later today (shown as "come back in N min" when nothing else is left). */
export function nextLearningDue(clock: StudyClock = studyClock(), filter: QueueFilter = {}): number | null {
	const f = filterSql(filter);
	const row = sqlite()
		.prepare(
			`SELECT min(c.due) AS due FROM card c JOIN note n ON n.id = c.note_id
			 WHERE ${ACTIVE} ${f.sql} AND c.state IN (1, 3) AND c.due < ?`
		)
		.get(...f.params, clock.dayEnd) as { due: number | null };
	return row.due;
}

/**
 * The order new cards are gathered in, as in Anki's default ("Deck" gather order):
 * cards made here first, then each Anki deck in deck-list order (parents before
 * subdecks), within a deck by the deck's own position, then by template.
 */
const NEW_GATHER_ORDER = "c.deck IS NOT NULL, replace(c.deck, '::', char(31)) COLLATE NOCASE, c.position, c.created_at, c.ord, c.id";

function pickNext(clock: StudyClock, exclude: string[], filter: QueueFilter): string | null {
	const conn = sqlite();
	const ex = exclude.length ? `AND c.id NOT IN (${exclude.map(() => '?').join(',')})` : '';
	const f = filterSql(filter);
	const base = `SELECT c.id FROM card c JOIN note n ON n.id = c.note_id WHERE ${ACTIVE} ${ex} ${f.sql}`;
	const learning = (until: number) =>
		conn
			.prepare(`${base} AND c.state IN (1, 3) AND c.due <= ? ORDER BY c.due LIMIT 1`)
			.get(...exclude, ...f.params, until) as { id: string } | undefined;
	// Order: learning steps that are due now, then due reviews, then new cards;
	// a learning step that isn't due yet is only shown early when nothing else is left.
	const dueNow = learning(clock.now);
	if (dueNow) return dueNow.id;
	if (filter.only !== 'new') {
		const review = conn
			.prepare(`${base} AND c.state = 2 AND c.due < ? ORDER BY c.due, c.id LIMIT 1`)
			.get(...exclude, ...f.params, clock.dayEnd) as { id: string } | undefined;
		if (review) return review.id;
	}
	const s = studySettings();
	const newLeft = s.newCardsPerDay - newIntroducedToday(clock);
	if (newLeft > 0 && filter.only !== 'due') {
		// Anki's default sort ("card type, then order gathered"): of today's batch of
		// new cards, every first card comes before any second card of the same notes,
		// so siblings (cloze 1 and cloze 2 of one note) don't follow each other.
		const fresh = conn
			.prepare(
				`SELECT id FROM (
					SELECT c.id AS id, c.ord AS ord, row_number() OVER (ORDER BY ${NEW_GATHER_ORDER}) AS gathered
					FROM card c JOIN note n ON n.id = c.note_id
					WHERE ${ACTIVE} ${ex} ${f.sql} AND c.state = 0 AND c.due < ?
					ORDER BY ${NEW_GATHER_ORDER} LIMIT ?
				) ORDER BY ord, gathered LIMIT 1`
			)
			.get(...exclude, ...f.params, clock.dayEnd, newLeft) as { id: string } | undefined;
		if (fresh) return fresh.id;
	}
	return learning(clock.now + LEARN_AHEAD_MS)?.id ?? null;
}

export interface ReviewCard {
	cardId: string;
	noteId: string;
	rev: number;
	ord: number;
	kind: NoteKind;
	fields: Record<string, string>;
	format: string;
	front: string;
	back: string;
	aamcCode: string | null;
	tags: string[];
	state: number;
	reps: number;
	lapses: number;
	lastReview: number | null;
	source: (AnchorView & { label: string }) | null;
	/** Pre-assigned id for this review; also the scheduler's fuzz seed. */
	eventId: string;
	intervals: Record<1 | 2 | 3 | 4, string>;
	leech: boolean;
	deck: string | null;
	/** Anki cards: the note type's styling, shown inside the card frame, and where the frame loads media from. */
	anki: { css: string; math: boolean; fieldNames: string[]; noteType: string; mediaBase: string } | null;
}

export function ankiShape(t: typeof noteType.$inferSelect): AnkiNoteTypeShape {
	return { name: t.name, kind: t.kind === 'anki_cloze' ? 'cloze' : 'standard', fields: t.fields, templates: t.templates };
}

/** Both sides of a card as HTML (Anki cards through their own templates, cleaned of scripts). */
export function renderCard(n: typeof note.$inferSelect, row: { ord: number; deck: string | null }) {
	const kind = kindForNoteType(n.noteTypeId);
	if (kind === 'anki') {
		const t = getNoteType(n.noteTypeId);
		if (t) {
			const r = renderAnkiCard(ankiShape(t), n.fields, row.ord, { tags: n.tags, deck: row.deck });
			return { kind, front: r.question, back: r.answer, anki: { css: t.css, math: r.math, fieldNames: t.fields, noteType: t.name, mediaBase: mediaBase() } };
		}
	}
	return { kind, front: renderCardSide(kind, n.fields, row.ord, 'front'), back: renderCardSide(kind, n.fields, row.ord, 'back'), anki: null };
}

export function reviewCard(cardId: string, clock: StudyClock = studyClock()): ReviewCard | null {
	const row = db().select().from(card).where(eq(card.id, cardId)).get();
	if (!row || row.deletedAt) return null;
	const n = db().select().from(note).where(eq(note.id, row.noteId)).get();
	if (!n || n.deletedAt) return null;
	const rendered = renderCard(n, row);
	const kind = rendered.kind;
	const eventId = uuidv7();
	const params = currentParams(studySettings().desiredRetention);
	const due = previewDue(schedState(row), params, clock.now, eventId);
	const a = anchorView(n.anchorId);
	return {
		cardId: row.id,
		noteId: n.id,
		rev: row.rev,
		ord: row.ord,
		kind,
		fields: n.fields,
		format: n.format,
		front: rendered.front,
		back: rendered.back,
		anki: rendered.anki,
		leech: row.leech,
		deck: row.deck,
		aamcCode: n.aamcCode,
		tags: n.tags,
		state: row.state,
		reps: row.reps,
		lapses: row.lapses,
		lastReview: row.lastReview,
		source: a ? { ...a, label: anchorLabel(a) } : null,
		eventId,
		intervals: {
			1: intervalLabel(due[1] - clock.now),
			2: intervalLabel(due[2] - clock.now),
			3: intervalLabel(due[3] - clock.now),
			4: intervalLabel(due[4] - clock.now)
		}
	};
}

export function nextReviewCard(exclude: string[] = [], filter: QueueFilter = {}) {
	const clock = studyClock();
	const id = pickNext(clock, exclude.slice(0, 500), filter);
	return id ? reviewCard(id, clock) : null;
}

export interface SubmitReview {
	cardId: string;
	rating: number;
	confidence?: Confidence | null;
	eventId: string;
	timeTakenMs: number;
	deviceId: string;
	deviceSeq: number;
	baseRev: number;
}

export type SubmitResult =
	| { status: 'saved'; eventId: string }
	| { status: 'duplicate'; eventId: string }
	| { status: 'conflict' };

/**
 * Records a review. The same event id twice has no further effect. If the card
 * changed since it was shown (reviewed elsewhere), nothing is saved.
 */
export function submitReview(input: SubmitReview): SubmitResult {
	const rating = Math.floor(input.rating);
	if (![1, 2, 3, 4].includes(rating)) throw new CardError('Rating must be Again, Hard, Good or Easy.');
	if (!/^[0-9a-f-]{36}$/.test(input.eventId)) throw new CardError('Bad review id.');
	const confidence = input.confidence && ['guess', 'unsure', 'sure'].includes(input.confidence) ? input.confidence : null;
	const deviceId = String(input.deviceId || 'unknown').slice(0, 64);

	return db().transaction((tx) => {
		const dup = tx.select({ id: reviewEvent.id }).from(reviewEvent).where(eq(reviewEvent.id, input.eventId)).get();
		if (dup) return { status: 'duplicate', eventId: input.eventId } as const;
		const row = tx.select().from(card).where(eq(card.id, input.cardId)).get();
		if (!row || row.deletedAt) throw new CardError('That card no longer exists.');
		if (row.rev !== input.baseRev) return { status: 'conflict' } as const;

		const settings = studySettings();
		const now = Date.now();
		const clock = studyClock(now, settings);
		const params = currentParams(settings.desiredRetention);
		const configId = ensureSchedulerConfig(params);
		const before = schedState(row);
		const after = applyRating(before, params, now, rating as Grade, input.eventId);
		const leech = row.leech || isLeechPoint(before.lapses, after.lapses, settings.leechThreshold);

		let seq = Math.floor(input.deviceSeq);
		const taken = tx
			.select({ id: reviewEvent.id })
			.from(reviewEvent)
			.where(and(eq(reviewEvent.deviceId, deviceId), eq(reviewEvent.deviceSeq, seq)))
			.get();
		if (!Number.isFinite(seq) || seq < 0 || taken) {
			const max = sqlite().prepare('SELECT max(device_seq) AS m FROM review_event WHERE device_id = ?').get(deviceId) as {
				m: number | null;
			};
			seq = (max.m ?? 0) + 1;
		}

		tx.insert(reviewEvent)
			.values({
				id: input.eventId,
				cardId: row.id,
				rating,
				confidence,
				reviewedAt: now,
				timeTakenMs: Math.max(0, Math.min(Math.floor(input.timeTakenMs) || 0, 600_000)),
				deviceId,
				deviceSeq: seq,
				baseRev: row.rev,
				schedulerConfigId: configId,
				seed: input.eventId,
				receivedAt: now,
				studyDay: clock.today,
				prevState: before.state,
				prevDue: before.due,
				nextState: after.state,
				nextDue: after.due,
				nextStability: after.stability,
				nextDifficulty: after.difficulty
			})
			.run();
		tx.update(card)
			.set({ ...after, rev: row.rev + 1, leech, updatedAt: now })
			.where(eq(card.id, row.id))
			.run();
		return { status: 'saved', eventId: input.eventId } as const;
	});
}

/**
 * Leech flagging (CARD-08), as in Anki: flagged when the lapse count reaches the
 * threshold, and again every half-threshold after that. The flag is only a
 * notice for the owner; the card's schedule and suspension are left alone.
 */
export function isLeechPoint(lapsesBefore: number, lapsesAfter: number, threshold: number): boolean {
	if (lapsesAfter <= lapsesBefore || lapsesAfter < threshold) return false;
	const step = Math.max(1, Math.ceil(threshold / 2));
	return (lapsesAfter - threshold) % step === 0;
}

/** "I fixed this card": clears the leech flag (it comes back if the card keeps lapsing). */
export function clearLeech(cardId: string) {
	db().update(card).set({ leech: false, updatedAt: Date.now() }).where(eq(card.id, cardId)).run();
}

export interface ImportedReview {
	/** Anki's review id (its millisecond timestamp); review history is deduplicated by it. */
	revlogId: number;
	rating: number;
	reviewedAt: number;
	timeTakenMs: number;
}

export const ANKI_DEVICE = 'anki';

/**
 * Adds review history from Anki to a card. The card's whole history (anything
 * already here plus the new reviews) is replayed in time order, so its state
 * is still exactly what replaying its stored events produces. Reviews already
 * imported (same Anki review id) are skipped. Call inside a transaction.
 */
export function mergeImportedReviews(cardId: string, incoming: ImportedReview[]): { added: number; duplicate: number } {
	const row = db().select().from(card).where(eq(card.id, cardId)).get();
	if (!row) return { added: 0, duplicate: incoming.length };
	const exists = sqlite().prepare('SELECT 1 FROM review_event WHERE device_id = ? AND device_seq = ?');
	const fresh = incoming.filter((r) => [1, 2, 3, 4].includes(r.rating) && !exists.get(ANKI_DEVICE, r.revlogId));
	const duplicate = incoming.length - fresh.length;
	if (!fresh.length) return { added: 0, duplicate };

	const settings = studySettings();
	const now = Date.now();
	const configId = ensureSchedulerConfig(currentParams(settings.desiredRetention));
	const existing = db()
		.select()
		.from(reviewEvent)
		.where(eq(reviewEvent.cardId, cardId))
		.orderBy(asc(reviewEvent.baseRev), asc(reviewEvent.reviewedAt))
		.all();
	type Ev = { id: string; rating: number; reviewedAt: number; seed: string; schedulerConfigId: string; existing: (typeof existing)[number] | null; source: ImportedReview | null };
	const all: Ev[] = [
		...existing.map((e) => ({ id: e.id, rating: e.rating, reviewedAt: e.reviewedAt, seed: e.seed, schedulerConfigId: e.schedulerConfigId, existing: e, source: null })),
		...fresh.map((r) => {
			const id = uuidv7At(r.reviewedAt);
			return { id, rating: r.rating, reviewedAt: r.reviewedAt, seed: id, schedulerConfigId: configId, existing: null, source: r };
		})
	].sort((a, b) => a.reviewedAt - b.reviewedAt || (a.id < b.id ? -1 : 1));

	const createdAt = Math.min(row.createdAt, all[0].reviewedAt);
	const changes = dueChangesFor(cardId);
	let c = 0;
	let s = emptyState(createdAt);
	let leech = row.leech;
	all.forEach((e, i) => {
		while (c < changes.length && changes[c].changedAt < e.reviewedAt) s = applyDueChange(s, changes[c++]);
		const before = s;
		const after = applyRating(before, loadSchedulerParams(e.schedulerConfigId), e.reviewedAt, e.rating as Grade, e.seed);
		const derived = {
			baseRev: i,
			prevState: before.state,
			prevDue: before.due,
			nextState: after.state,
			nextDue: after.due,
			nextStability: after.stability,
			nextDifficulty: after.difficulty
		};
		if (e.source) {
			if (isLeechPoint(before.lapses, after.lapses, settings.leechThreshold)) leech = true;
			db()
				.insert(reviewEvent)
				.values({
					id: e.id,
					cardId,
					rating: e.rating,
					confidence: null,
					reviewedAt: e.reviewedAt,
					timeTakenMs: Math.max(0, Math.min(Math.floor(e.source.timeTakenMs) || 0, 600_000)),
					deviceId: ANKI_DEVICE,
					deviceSeq: e.source.revlogId,
					schedulerConfigId: e.schedulerConfigId,
					seed: e.seed,
					receivedAt: now,
					studyDay: studyDayOf(e.reviewedAt, settings.timeZone, settings.dayStartHour),
					...derived
				})
				.run();
		} else if (e.existing) {
			const x = e.existing;
			if (
				x.baseRev !== derived.baseRev ||
				x.prevState !== derived.prevState ||
				x.prevDue !== derived.prevDue ||
				x.nextState !== derived.nextState ||
				x.nextDue !== derived.nextDue ||
				x.nextStability !== derived.nextStability ||
				x.nextDifficulty !== derived.nextDifficulty
			) {
				db().update(reviewEvent).set(derived).where(eq(reviewEvent.id, x.id)).run();
			}
		}
		s = after;
	});
	while (c < changes.length) s = applyDueChange(s, changes[c++]);
	db()
		.update(card)
		.set({ ...s, rev: all.length, leech, createdAt, updatedAt: now })
		.where(eq(card.id, cardId))
		.run();
	return { added: fresh.length, duplicate };
}

function dueChangesFor(cardId: string) {
	return db()
		.select({ due: cardDueChange.due, changedAt: cardDueChange.changedAt })
		.from(cardDueChange)
		.where(eq(cardDueChange.cardId, cardId))
		.orderBy(asc(cardDueChange.changedAt), asc(cardDueChange.id))
		.all();
}

// ------------------------------------------------------- set due date

/**
 * When cards should come up next. `date`: a study day (YYYY-MM-DD); `days`:
 * that many days from today; `range`: a random day in [min, max] for each card,
 * to spread a pile of cards out (as Anki's "3-7").
 */
export type DueSpec = { kind: 'date'; date: string } | { kind: 'days'; days: number } | { kind: 'range'; min: number; max: number };

/** Which cards of a deck a deck-wide change applies to. */
export type DueScope = 'due' | 'review' | 'all';

export interface DueResult {
	changed: number;
	/** New cards left alone (scope didn't include them). */
	skipped: number;
	/** The first and last study day the cards now land on. */
	from: string | null;
	to: string | null;
}

const MAX_DUE_DAYS = 3650;

/** Study days from today for a spec (random per card for a range). */
function daysFor(spec: DueSpec, today: string, rand: () => number): number {
	if (spec.kind === 'date') {
		if (!/^\d{4}-\d{2}-\d{2}$/.test(spec.date)) throw new CardError('Pick a date.');
		return diffDays(today, spec.date);
	}
	if (spec.kind === 'days') return Math.round(spec.days);
	const lo = Math.round(Math.min(spec.min, spec.max));
	const hi = Math.round(Math.max(spec.min, spec.max));
	return lo + Math.floor(rand() * (hi - lo + 1));
}

/**
 * Sets when cards come up next (Anki's "Set due date"). Reviews and learning
 * cards become due at the start of that study day; their memory (stability,
 * difficulty, interval history) is unchanged, so the next answer is scheduled
 * as usual from how long it has really been. A new card stays new and simply
 * isn't shown before that day. Each change is stored and replayed like a review.
 */
export function setCardsDue(cardIds: string[], spec: DueSpec, opts: { includeNew?: boolean; source?: 'manual' | 'anki'; rand?: () => number } = {}): DueResult {
	const ids = [...new Set(cardIds)].slice(0, 50_000);
	const settings = studySettings();
	const clock = studyClock(Date.now(), settings);
	const rand = opts.rand ?? Math.random;
	const result: DueResult = { changed: 0, skipped: 0, from: null, to: null };
	if (!ids.length) return result;
	const includeNew = opts.includeNew ?? true;
	inTx(() => {
		for (let i = 0; i < ids.length; i += 500) {
			const rows = db()
				.select()
				.from(card)
				.where(and(inArray(card.id, ids.slice(i, i + 500)), isNull(card.deletedAt)))
				.all();
			for (const row of rows) {
				if (row.state === 0 && !includeNew) {
					result.skipped++;
					continue;
				}
				const days = daysFor(spec, clock.today, rand);
				if (days < 0) throw new CardError('Pick today or a later day.');
				if (days > MAX_DUE_DAYS) throw new CardError('Pick a day within the next ten years.');
				const day = addDays(clock.today, days);
				// Today: due now (it shows up right away). Later days: when that study day starts.
				const due = days === 0 ? Math.min(row.due, clock.now) : studyDayStart(day, settings.timeZone, settings.dayStartHour);
				if (due === row.due) {
					result.changed++;
				} else {
					const now = Date.now();
					db()
						.insert(cardDueChange)
						.values({ id: uuidv7(), cardId: row.id, due, prevDue: row.due, source: opts.source ?? 'manual', changedAt: now, studyDay: clock.today })
						.run();
					db().update(card).set({ due, updatedAt: now }).where(eq(card.id, row.id)).run();
					result.changed++;
				}
				if (!result.from || day < result.from) result.from = day;
				if (!result.to || day > result.to) result.to = day;
			}
		}
	});
	return result;
}

/** Cards of a deck (and its subdecks) for a deck-wide due date change. */
export function deckCardIds(deck: string, scope: DueScope, clock: StudyClock = studyClock()): string[] {
	const f = filterSql({ deck });
	const cond = scope === 'due' ? `AND ((c.state = 2 AND c.due < ?) OR (c.state IN (1, 3) AND c.due <= ?))` : scope === 'review' ? 'AND c.state <> 0' : '';
	const params = scope === 'due' ? [clock.dayEnd, clock.now + LEARN_AHEAD_MS] : [];
	return (
		sqlite()
			.prepare(`SELECT c.id FROM card c JOIN note n ON n.id = c.note_id WHERE c.deleted_at IS NULL AND n.deleted_at IS NULL ${f.sql} ${cond}`)
			.all(...f.params, ...params) as { id: string }[]
	).map((r) => r.id);
}

/** Replays every card's reviews and compares with the stored state (M1 check). */
export function verifyReplay() {
	const cards = db().select().from(card).all();
	const events = db().select().from(reviewEvent).orderBy(asc(reviewEvent.reviewedAt), asc(reviewEvent.id)).all();
	const byCard = new Map<string, typeof events>();
	for (const e of events) {
		const list = byCard.get(e.cardId) ?? [];
		list.push(e);
		byCard.set(e.cardId, list);
	}
	const changes = new Map<string, { due: number; changedAt: number }[]>();
	for (const ch of db().select().from(cardDueChange).orderBy(asc(cardDueChange.changedAt), asc(cardDueChange.id)).all()) {
		const list = changes.get(ch.cardId) ?? [];
		list.push({ due: ch.due, changedAt: ch.changedAt });
		changes.set(ch.cardId, list);
	}
	const mismatches: { cardId: string; stored: unknown; replayed: unknown }[] = [];
	let checked = 0;
	for (const c of cards) {
		const evs = (byCard.get(c.id) ?? []).sort((a, b) => a.baseRev - b.baseRev || a.reviewedAt - b.reviewedAt);
		const replayed = replay(c.createdAt, evs, changes.get(c.id) ?? []);
		checked++;
		if (!sameState(replayed, schedState(c))) {
			mismatches.push({ cardId: c.id, stored: schedState(c), replayed });
		}
	}
	return { checked, events: events.length, mismatches };
}

// ------------------------------------------------------- card browser

export interface CardListItem {
	cardId: string;
	noteId: string;
	ord: number;
	kind: NoteKind;
	preview: string;
	aamcCode: string | null;
	state: number;
	due: number;
	reps: number;
	lapses: number;
	suspended: boolean;
	leech: boolean;
	deck: string | null;
	origin: string;
	source: string;
	sourceAvailable: boolean | null;
	createdAt: number;
}

export function listCards(opts: {
	q?: string;
	aamcCode?: string | null;
	state?: 'new' | 'learning' | 'review' | 'suspended' | 'due' | 'leech' | null;
	documentId?: string | null;
	deck?: string | null;
	limit?: number;
	offset?: number;
}) {
	const where = ['c.deleted_at IS NULL', 'n.deleted_at IS NULL'];
	const params: unknown[] = [];
	if (opts.aamcCode) {
		where.push('n.aamc_code = ?');
		params.push(opts.aamcCode);
	}
	if (opts.deck) {
		where.push("(c.deck = ? OR c.deck LIKE ? ESCAPE '\\')");
		params.push(opts.deck, opts.deck.replace(/[\\%_]/g, (m) => '\\' + m) + '::%');
	}
	if (opts.state === 'leech') where.push('c.leech = 1');
	if (opts.documentId) {
		where.push('n.anchor_id IN (SELECT id FROM anchor WHERE document_id = ?)');
		params.push(opts.documentId);
	}
	if (opts.state === 'new') where.push('c.state = 0 AND c.suspended = 0');
	if (opts.state === 'learning') where.push('c.state IN (1, 3) AND c.suspended = 0');
	if (opts.state === 'review') where.push('c.state = 2 AND c.suspended = 0');
	if (opts.state === 'suspended') where.push('c.suspended = 1');
	if (opts.state === 'due') {
		where.push('c.suspended = 0 AND ((c.state = 2 AND c.due < ?) OR (c.state IN (1,3) AND c.due <= ?))');
		const clock = studyClock();
		params.push(clock.dayEnd, clock.now + LEARN_AHEAD_MS);
	}
	if (opts.q?.trim()) {
		const ids = (
			sqlite()
				.prepare("SELECT ref_id FROM search_index WHERE search_index MATCH ? AND kind = 'card' LIMIT 2000")
				.all(ftsOrNull(opts.q) ?? '""') as { ref_id: string }[]
		).map((r) => r.ref_id);
		if (!ids.length) return { items: [] as CardListItem[], total: 0 };
		where.push(`n.id IN (${ids.map(() => '?').join(',')})`);
		params.push(...ids);
	}
	const conn = sqlite();
	const total = (
		conn.prepare(`SELECT count(*) AS n FROM card c JOIN note n ON n.id = c.note_id WHERE ${where.join(' AND ')}`).get(...params) as {
			n: number;
		}
	).n;
	const rows = conn
		.prepare(
			`SELECT c.id AS card_id, n.id AS note_id, c.ord, n.note_type_id, n.fields, n.aamc_code, n.anchor_id, n.origin,
			        c.state, c.due, c.reps, c.lapses, c.suspended, c.leech, c.deck, c.created_at
			 FROM card c JOIN note n ON n.id = c.note_id
			 WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC, c.ord LIMIT ? OFFSET ?`
		)
		.all(...params, opts.limit ?? 50, opts.offset ?? 0) as {
		card_id: string;
		note_id: string;
		ord: number;
		note_type_id: string;
		fields: string;
		aamc_code: string | null;
		anchor_id: string | null;
		origin: string;
		state: number;
		due: number;
		reps: number;
		lapses: number;
		suspended: number;
		leech: number;
		deck: string | null;
		created_at: number;
	}[];
	const anchors = anchorViews(rows.map((r) => r.anchor_id ?? '').filter(Boolean));
	return {
		total,
		items: rows.map((r): CardListItem => {
			const kind = kindForNoteType(r.note_type_id);
			const fields = JSON.parse(r.fields) as Record<string, string>;
			const a = r.anchor_id ? (anchors.get(r.anchor_id) ?? null) : null;
			const sides = cardSides(kind, fields, r.ord);
			return {
				cardId: r.card_id,
				noteId: r.note_id,
				ord: r.ord,
				kind,
				preview:
					kind === 'anki'
						? notePreview(kind, fields)
						: kind === 'cloze'
							? notePreview(kind, { Text: sides.front.replace(/<[^>]+>/g, '') })
							: notePreview(kind, { Front: sides.front }),
				aamcCode: r.aamc_code,
				state: r.state,
				due: r.due,
				reps: r.reps,
				lapses: r.lapses,
				suspended: !!r.suspended,
				leech: !!r.leech,
				deck: r.deck,
				origin: r.origin,
				source: a ? anchorLabel(a) : '',
				sourceAvailable: a ? a.available : null,
				createdAt: r.created_at
			};
		})
	};
}

function ftsOrNull(q: string) {
	const words = q.match(/[\p{L}\p{N}]+/gu);
	return words?.length ? words.map((w) => `"${w}"*`).join(' ') : null;
}

export function noteForEdit(noteId: string) {
	const n = getNote(noteId);
	if (!n) return null;
	const a = anchorView(n.anchorId);
	const kind = kindForNoteType(n.noteTypeId);
	const type = kind === 'anki' ? getNoteType(n.noteTypeId) : null;
	return {
		noteId: n.id,
		kind,
		fields: n.fields,
		/** Anki notes: field order and note type name, for the editor. */
		fieldNames: type ? type.fields : null,
		noteTypeName: type ? type.name : null,
		noteTypeId: n.noteTypeId,
		/** Where the card type came from: anki (imported), custom (made here), builtin. */
		noteTypeSource: type ? type.source : 'builtin',
		origin: n.origin,
		aamcCode: n.aamcCode,
		tags: n.tags,
		source: a ? { ...a, label: anchorLabel(a) } : null
	};
}

export interface DeckRow {
	/** Full name, like "MCAT::Biochemistry". */
	deck: string;
	/** Last part of the name, like "Biochemistry". */
	label: string;
	/** 0 for a top-level deck. */
	depth: number;
	/** Cards in this deck and its subdecks. */
	cards: number;
	new: number;
	learning: number;
	review: number;
	hasChildren: boolean;
}

/**
 * The Anki decks imported cards came from, as a tree in Anki's deck-list order,
 * each with card counts that include its subdecks. Parent decks that hold no
 * cards themselves are listed too, so a whole deck can be studied at once.
 */
export function cardDecks(clock: StudyClock = studyClock()): DeckRow[] {
	const rows = sqlite()
		.prepare(
			`SELECT c.deck AS deck, count(*) AS cards,
			        sum(CASE WHEN c.suspended = 0 AND c.state = 0 THEN 1 ELSE 0 END) AS new,
			        sum(CASE WHEN c.suspended = 0 AND c.state IN (1, 3) AND c.due <= ? THEN 1 ELSE 0 END) AS learning,
			        sum(CASE WHEN c.suspended = 0 AND c.state = 2 AND c.due < ? THEN 1 ELSE 0 END) AS review
			 FROM card c JOIN note n ON n.id = c.note_id
			 WHERE c.deck IS NOT NULL AND c.deleted_at IS NULL AND n.deleted_at IS NULL GROUP BY c.deck`
		)
		.all(clock.now + LEARN_AHEAD_MS, clock.dayEnd) as { deck: string; cards: number; new: number; learning: number; review: number }[];
	const byName = new Map<string, DeckRow>();
	for (const r of rows) {
		const parts = r.deck.split('::');
		for (let i = 1; i <= parts.length; i++) {
			const name = parts.slice(0, i).join('::');
			const row =
				byName.get(name) ??
				byName.set(name, { deck: name, label: parts[i - 1], depth: i - 1, cards: 0, new: 0, learning: 0, review: 0, hasChildren: false }).get(name)!;
			row.cards += r.cards;
			row.new += r.new;
			row.learning += r.learning;
			row.review += r.review;
			if (i < parts.length) row.hasChildren = true;
		}
	}
	const key = (name: string) => name.split('::').map((p) => p.toLowerCase());
	return [...byName.values()].sort((a, b) => {
		const ka = key(a.deck);
		const kb = key(b.deck);
		for (let i = 0; i < Math.min(ka.length, kb.length); i++) if (ka[i] !== kb[i]) return ka[i] < kb[i] ? -1 : 1;
		return ka.length - kb.length;
	});
}

export function leechCount(): number {
	return (
		sqlite()
			.prepare('SELECT count(*) AS n FROM card c JOIN note n ON n.id = c.note_id WHERE c.leech = 1 AND c.deleted_at IS NULL AND n.deleted_at IS NULL')
			.get() as { n: number }
	).n;
}

export function cardsByIds(ids: string[]) {
	if (!ids.length) return [];
	return db().select().from(card).where(inArray(card.id, ids)).all() as CardRow[];
}
