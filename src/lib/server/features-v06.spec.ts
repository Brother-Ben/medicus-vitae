// Checks for the 0.6 features against the real server modules and a throwaway
// data folder: due dates set by hand, resetting data, notes PDFs linked to book
// pages, focus sessions, and Anki sync (against a stand-in AnkiConnect).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-test-v06-'));
process.env.CORTEX_DATA_DIR = dir;
process.env.CORTEX_ENV_LOADED = '1';
process.env.CORTEX_EMBEDDINGS = 'off';

type Mods = {
	config: typeof import('./config');
	db: typeof import('./db');
	schema: typeof import('./db/schema');
	instance: typeof import('./instance');
	cards: typeof import('./cards');
	fsrs: typeof import('./fsrs');
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
		fsrs: await import('./fsrs'),
		settings: await import('./settings')
	};
	m.config.ensureDataDirs();
	m.db.openLocalDatabase();
	await m.db.openMainDatabase();
	m.instance.ensureInstance();
	m.db
		.db()
		.insert(m.schema.user)
		.values({ id: 1, passwordHash: 'x', timeZone: 'America/Chicago', dayStartHour: 4, createdAt: T0, updatedAt: T0 })
		.run();
});

afterAll(async () => {
	vi.useRealTimers();
	// A reset asks the search indexer to catch up; stop it before closing its files.
	await (await import('./ai/indexer')).stopIndexer();
	(await import('./ai/index-db')).closeIndexDb();
	m?.db.closeDatabases();
	fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

let seq = 0;
function review(cardId: string, rating: number) {
	const c = m.cards.reviewCard(cardId)!;
	return m.cards.submitReview({ cardId, rating, eventId: c.eventId, timeTakenMs: 8000, deviceId: 'test', deviceSeq: ++seq, baseRev: c.rev });
}
const cardRow = (id: string) => m.cards.cardsByIds([id])[0];

describe('set due date', () => {
	it('moves only the due date, and replaying the history reproduces it', async () => {
		const n = m.cards.createNote({ kind: 'basic', fields: { Front: 'Km?', Back: 'Half Vmax' } });
		const id = n.cardIds[0];
		review(id, 3);
		vi.setSystemTime(T0 + 3 * 86_400_000);
		review(id, 3);
		const before = cardRow(id);
		const r = m.cards.setCardsDue([id], { kind: 'days', days: 10 });
		expect(r.changed).toBe(1);
		const after = cardRow(id);
		expect(after.due).not.toBe(before.due);
		expect(after.stability).toBe(before.stability);
		expect(after.difficulty).toBe(before.difficulty);
		// Due when that study day starts (4 a.m. in Chicago), ten days from today.
		const clock = m.settings.studyClock();
		const { addDays, studyDayStart } = await import('../dates');
		expect(r.from).toBe(addDays(clock.today, 10));
		expect(after.due).toBe(studyDayStart(r.from!, 'America/Chicago', 4));
		expect(m.cards.verifyReplay().mismatches).toEqual([]);
		// A later review schedules from the real memory state and still replays exactly.
		vi.setSystemTime(after.due + 3600_000);
		expect(review(id, 3).status).toBe('saved');
		expect(m.cards.verifyReplay().mismatches).toEqual([]);
	});

	it('"today" makes a later card due now; a range spreads cards out', () => {
		const n = m.cards.createNote({ kind: 'cloze', fields: { Text: '{{c1::a}} {{c2::b}} {{c3::c}} {{c4::d}}' } });
		for (const id of n.cardIds) review(id, 4);
		const now = Date.now();
		m.cards.setCardsDue([n.cardIds[0]], { kind: 'days', days: 0 });
		expect(cardRow(n.cardIds[0]).due).toBeLessThanOrEqual(now);
		let i = 0;
		const rolls = [0, 0.99, 0.5];
		const r = m.cards.setCardsDue(n.cardIds.slice(1), { kind: 'range', min: 2, max: 4 }, { rand: () => rolls[i++ % 3] });
		expect(r.changed).toBe(3);
		const clock = m.settings.studyClock();
		const days = n.cardIds.slice(1).map((id) => m.settings.studyDayFor(cardRow(id).due));
		expect(new Set(days).size).toBe(3);
		expect(r.from! > clock.today).toBe(true);
		expect(m.cards.verifyReplay().mismatches).toEqual([]);
	});

	it('a new card stays new and waits until its start day', () => {
		const n = m.cards.createNote({ kind: 'basic', fields: { Front: 'later', Back: 'x' } });
		const before = m.cards.queueCounts().new;
		m.cards.setCardsDue(n.cardIds, { kind: 'days', days: 5 });
		expect(cardRow(n.cardIds[0]).state).toBe(0);
		expect(m.cards.queueCounts().new).toBe(before - 1);
		vi.setSystemTime(Date.now() + 6 * 86_400_000);
		expect(m.cards.queueCounts().new).toBeGreaterThanOrEqual(before);
		vi.setSystemTime(T0 + 3 * 86_400_000);
	});

	it('keeps due dates set by hand when Anki review history is merged in later', () => {
		const n = m.cards.createNote({ kind: 'basic', fields: { Front: 'merge', Back: 'x' } });
		const id = n.cardIds[0];
		review(id, 3);
		m.cards.setCardsDue([id], { kind: 'days', days: 20 });
		const due = cardRow(id).due;
		m.cards.mergeImportedReviews(id, [{ revlogId: T0 - 5 * 86_400_000, rating: 3, reviewedAt: T0 - 5 * 86_400_000, timeTakenMs: 5000 }]);
		expect(cardRow(id).due).toBe(due);
		expect(m.cards.verifyReplay().mismatches).toEqual([]);
	});

	it('refuses past dates', () => {
		const n = m.cards.createNote({ kind: 'basic', fields: { Front: 'past', Back: 'x' } });
		expect(() => m.cards.setCardsDue(n.cardIds, { kind: 'date', date: '2020-01-01' })).toThrow(/today or a later day/);
	});
});

const count = (t: string) => (m.db.sqlite().prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;

describe('focus timer', () => {
	it('runs focus → break → focus, with a long break after the set number of rounds', async () => {
		const f = await import('../focus');
		const cfg = { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, roundsBeforeLong: 2, autoStartBreaks: true, autoStartFocus: true };
		let now = 1_000_000;
		let t = f.startTimer(cfg, now, 'a');
		expect(f.timeLeft(t, now)).toBe(25 * 60);
		// Pausing stops the clock.
		t = f.pauseTimer(t, (now += 60_000));
		now += 10 * 60_000;
		expect(f.timeLeft(t, now)).toBe(24 * 60);
		t = f.resumeTimer(t, now);
		now += 24 * 60_000;
		expect(f.timeLeft(t, now)).toBe(0);
		t = f.nextPhase(t, cfg, now);
		expect([t.phase, t.breakKind, t.rounds, t.phaseSeconds]).toEqual(['break', 'short', 1, 300]);
		expect(t.focusedSeconds).toBe(25 * 60);
		t = f.nextPhase(t, cfg, (now += 300_000));
		expect(t.phase).toBe('focus');
		t = f.nextPhase(t, cfg, (now += 25 * 60_000));
		expect([t.phase, t.breakKind, t.rounds]).toEqual(['break', 'long', 2]);
		t = f.extendTimer(t, 5);
		expect(t.phaseSeconds).toBe(20 * 60);
	});

	it('waits for you when breaks or rounds don’t start by themselves', async () => {
		const f = await import('../focus');
		const cfg = { focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, roundsBeforeLong: 4, autoStartBreaks: false, autoStartFocus: false };
		let t = f.startTimer(cfg, 0, null);
		t = f.nextPhase(t, cfg, 25 * 60_000);
		expect(t.phase).toBe('ready-break');
		expect(f.timeLeft(t, 99 * 60_000)).toBe(0);
		t = f.nextPhase(t, cfg, 30 * 60_000);
		expect([t.phase, f.timeLeft(t, 30 * 60_000)]).toEqual(['break', 300]);
		t = f.nextPhase(t, cfg, 35 * 60_000);
		expect(t.phase).toBe('ready-focus');
	});
});

describe('study sessions', () => {
	it('starts with the first item, moves on as items finish, and finishes reading items by itself', async () => {
		const planner = await import('./planner');
		const plan = [
			{ id: 'i1', type: 'custom' as const, title: 'UWorld block', detail: '', why: '', minutes: 20 },
			{ id: 'i2', type: 'reading' as const, title: 'Read', detail: '', why: '', minutes: 10, documentId: 'doc-1', fromPage: 3, toPage: 6 },
			{ id: 'i3', type: 'reviews' as const, title: 'Cards', detail: '', why: '', minutes: 5, count: 10, deck: 'MCAT::Bio' }
		];
		const id = planner.saveSessionPlan(45, plan, { title: 'Morning', focus: { focusMinutes: 30 } });
		let s = planner.getSessionPlan(id)!;
		expect(s.title).toBe('Morning');
		expect(s.focus?.focusMinutes).toBe(30);
		expect(s.timer?.phase).toBe('focus');
		expect(s.currentItemId).toBe('i1');
		planner.setSessionItemDone(id, 'i1', true);
		expect(planner.getSessionPlan(id)!.currentItemId).toBe('i2');
		planner.completeSessionWork({ readingDoc: 'doc-1', page: 5 });
		expect(planner.getSessionPlan(id)!.items[1].done).toBe(false);
		planner.completeSessionWork({ readingDoc: 'doc-1', page: 6 });
		s = planner.getSessionPlan(id)!;
		expect(s.items[1].done).toBe(true);
		expect(s.currentItemId).toBe('i3');
		// Editing while it runs.
		planner.editSession(id, { add: [{ id: 'i4', type: 'custom', title: 'CARS passage', detail: '', why: '', minutes: 10 }], budgetMinutes: 60 });
		s = planner.getSessionPlan(id)!;
		expect(s.items.map((i) => i.id)).toEqual(['i1', 'i2', 'i3', 'i4']);
		expect(s.budgetMinutes).toBe(60);
		// The timer only moves to the break when the time is really up.
		expect(planner.timerAction(id, 'next-phase')?.phase).toBe('focus');
		expect(planner.timerAction(id, 'skip')?.phase).toBe('break');
		// A new session ends the old one.
		const other = planner.saveSessionPlan(15, [plan[0]], { focus: null });
		expect(planner.getSessionPlan(id)!.status).toBe('abandoned');
		expect(planner.activeSession()?.id).toBe(other);
		expect(planner.getSessionPlan(other)!.timer).toBeNull();
	});

	it('keeps suggested flashcards to the deck asked for', async () => {
		const planner = await import('./planner');
		const r = planner.buildSession(30, { deck: 'Nope::Missing' });
		expect(r.items.every((i) => i.type !== 'reviews' && i.type !== 'new')).toBe(true);
	});
});

describe('notes PDFs', () => {
	function doc(id: string, role: 'book' | 'notes', pageCount: number) {
		m.db
			.db()
			.insert(m.schema.document)
			.values({ id, title: `${role} ${id}`, fileHash: `hash-${id}`, fileName: `${id}.pdf`, fileSize: 1, pageCount, status: 'ready', role, createdAt: T0, updatedAt: T0 })
			.run();
	}

	it('links notes pages to book pages, shows them on those pages, and keeps them out of the Library', async () => {
		const notes = await import('./notes');
		const library = await import('./library');
		doc('book-a', 'book', 300);
		doc('notes-a', 'notes', 12);
		expect(library.listDocuments().map((d) => d.id)).toContain('book-a');
		expect(library.listDocuments().map((d) => d.id)).not.toContain('notes-a');
		expect(library.listDocuments('notes').map((d) => d.id)).toEqual(['notes-a']);
		const id = notes.addLink({ notesDocumentId: 'notes-a', notesPageFrom: 3, notesPageTo: 5, bookDocumentId: 'book-a', bookPageFrom: 40, bookPageTo: 48, label: 'Enzymes' });
		expect(notes.notesForBookPage('book-a', 44).map((l) => l.id)).toEqual([id]);
		expect(notes.notesForBookPage('book-a', 49)).toEqual([]);
		// Pages are kept inside the files.
		notes.updateLink(id, { notesDocumentId: 'notes-a', notesPageFrom: 9, notesPageTo: 99, bookDocumentId: 'book-a', bookPageFrom: 290, bookPageTo: 999 });
		const l = notes.notesFiles()[0].links[0];
		expect([l.notesPageFrom, l.notesPageTo, l.bookPageFrom, l.bookPageTo]).toEqual([9, 12, 290, 300]);
		expect(() => notes.addLink({ notesDocumentId: 'book-a', bookDocumentId: 'book-a', bookPageFrom: 1 })).toThrow();
		notes.deleteNotesFile('notes-a');
		expect(library.listDocuments('notes')).toEqual([]);
		expect(notes.notesForBookPage('book-a', 295)).toEqual([]);
	});
});

describe('reset data', () => {
	it('clears only the parts picked, keeps the rest working, and can be undone', async () => {
		const reset = await import('./reset');
		const practice = await import('./practice');
		const n = m.cards.createNote({ kind: 'basic', fields: { Front: 'reset me', Back: 'x' } });
		review(n.cardIds[0], 1);
		const mkId = practice.createMistake({ sourceType: 'card', cardId: n.cardIds[0], reason: 'content_gap', aamcCode: '1A', summary: 'kept' });
		expect(count('card')).toBeGreaterThan(0);
		const r = await reset.resetData(['cards']);
		expect(r.snapshotId).toMatch(/pre-reset/);
		expect(count('card')).toBe(0);
		expect(count('review_event')).toBe(0);
		expect(count('card_due_change')).toBe(0);
		const kept = m.db.sqlite().prepare('SELECT card_id, summary FROM mistake WHERE id = ?').get(mkId) as { card_id: string | null; summary: string };
		expect(kept).toEqual({ card_id: null, summary: 'kept' });
		expect(count('user')).toBe(1);
		// Cards can be made and reviewed again right away.
		const again = m.cards.createNote({ kind: 'basic', fields: { Front: 'fresh', Back: 'start' } });
		expect(review(again.cardIds[0], 3).status).toBe('saved');
		expect(m.cards.verifyReplay().mismatches).toEqual([]);
	});

	it('"everything" goes back to first-run setup', async () => {
		const reset = await import('./reset');
		const auth = await import('./auth');
		await reset.resetData('everything');
		expect(auth.hasUser()).toBe(false);
		expect(count('note')).toBe(0);
		expect(count('mistake')).toBe(0);
		expect(count('instance')).toBe(1);
		// Back for the remaining tests.
		m.db
			.db()
			.insert(m.schema.user)
			.values({ id: 1, passwordHash: 'x', timeZone: 'America/Chicago', dayStartHour: 4, createdAt: T0, updatedAt: T0 })
			.run();
	});
});
