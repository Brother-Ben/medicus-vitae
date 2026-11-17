// The study queue: studying one deck stays in that deck (and its subdecks), new
// cards come in each deck's own order, and of a day's new cards the first card of
// every note comes before any second card (Anki's "card type, then order gathered").

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-queue-'));
process.env.CORTEX_DATA_DIR = dir;
process.env.CORTEX_ENV_LOADED = '1';

type Mods = {
	config: typeof import('./config');
	db: typeof import('./db');
	schema: typeof import('./db/schema');
	instance: typeof import('./instance');
	cards: typeof import('./cards');
	settings: typeof import('./settings');
};
let m: Mods;
const T0 = Date.parse('2026-10-20T15:00:00Z');

beforeAll(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
	m = {
		config: await import('./config'),
		db: await import('./db'),
		schema: await import('./db/schema'),
		instance: await import('./instance'),
		cards: await import('./cards'),
		settings: await import('./settings')
	};
	m.config.ensureDataDirs();
	m.db.openLocalDatabase();
	await m.db.openMainDatabase();
	m.instance.ensureInstance();
	m.db
		.db()
		.insert(m.schema.user)
		.values({ id: 1, passwordHash: 'x', timeZone: 'America/Chicago', dayStartHour: 4, newCardsPerDay: 100, createdAt: T0, updatedAt: T0 })
		.run();
});

afterAll(() => {
	vi.useRealTimers();
	m?.db.closeDatabases();
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A two-card note placed in an Anki deck at a deck position. */
function deckNote(label: string, deck: string | null, position: number | null) {
	const n = m.cards.createNote({ kind: 'basic_reversed', fields: { Front: label, Back: `${label} back` } });
	m.db.sqlite().prepare('UPDATE card SET deck = ?, position = ? WHERE note_id = ?').run(deck, position, n.noteId);
	return n;
}

const front = (cardId: string) => m.cards.reviewCard(cardId)!;

let seq = 0;
/** Studies the next card of a filter (rating Good) and returns its label and side. */
function studyNext(filter: import('./cards').QueueFilter = {}) {
	const c = m.cards.nextReviewCard([], filter);
	if (!c) return null;
	m.cards.submitReview({ cardId: c.cardId, rating: 3, eventId: c.eventId, timeTakenMs: 4000, deviceId: 'test', deviceSeq: ++seq, baseRev: c.rev });
	return `${c.fields.Front}${c.ord ? ' (reverse)' : ''}`;
}

describe('study queue', () => {
	it('keeps to the chosen deck and its subdecks, in the deck’s own order', () => {
		// Made in this order, but deck B's positions say B2 comes before B1.
		deckNote('B1', 'Deck B', 5);
		deckNote('B2', 'Deck B', 1);
		deckNote('A-sub', 'Deck A::Sub', 0);
		deckNote('A-top', 'Deck A', 9);
		deckNote('Mine', null, null);

		const counts = m.cards.queueCounts(m.settings.studyClock(), { deck: 'Deck B' });
		expect(counts.new).toBe(4);
		expect(m.cards.queueCounts(m.settings.studyClock(), { deck: 'Deck A' }).new).toBe(4);

		const seenB: string[] = [];
		for (let i = 0; i < 4; i++) seenB.push(studyNext({ deck: 'Deck B' })!);
		// Only deck B, B2 before B1, and both first cards before either reverse card.
		expect(seenB).toEqual(['B2', 'B1', 'B2 (reverse)', 'B1 (reverse)']);
		expect(m.cards.nextReviewCard([], { deck: 'Deck B' })?.fields.Front ?? null).not.toMatch(/^A|Mine/);
	});

	it('takes a parent deck’s own cards before its subdecks', () => {
		const order: string[] = [];
		for (let i = 0; i < 2; i++) order.push(studyNext({ deck: 'Deck A' })!);
		expect(order).toEqual(['A-top', 'A-sub']);
	});

	it('lists decks as a tree with counts that include subdecks', () => {
		const decks = m.cards.cardDecks(m.settings.studyClock());
		expect(decks.map((d) => `${'  '.repeat(d.depth)}${d.label}`)).toEqual(['Deck A', '  Sub', 'Deck B']);
		const a = decks.find((d) => d.deck === 'Deck A')!;
		expect(a.cards).toBe(4);
		expect(a.hasChildren).toBe(true);
		expect(front(m.cards.nextReviewCard([], { deck: 'Deck A' })!.cardId).deck).toMatch(/^Deck A/);
	});
});
