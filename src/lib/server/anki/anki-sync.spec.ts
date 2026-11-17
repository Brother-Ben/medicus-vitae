// Anki sync against a stand-in AnkiConnect: the first sync reads the deck in
// (with history) and sends cards and reviews made here; later syncs pull only
// new reviews, never pull back reviews this app wrote, and never send twice.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { deckContent, makeAnkiPackage } from '../../../../tests/fixtures/make-anki-packages.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-ankisync-'));
process.env.CORTEX_DATA_DIR = dir;
process.env.CORTEX_ENV_LOADED = '1';
process.env.CORTEX_EMBEDDINGS = 'off';

type Mods = {
	config: typeof import('../config');
	db: typeof import('../db');
	schema: typeof import('../db/schema');
	instance: typeof import('../instance');
	cards: typeof import('../cards');
	connect: typeof import('./connect');
	sync: typeof import('./sync');
};
let m: Mods;
const T0 = Date.parse('2026-10-20T15:00:00Z');

/** A tiny Anki collection behind a fake AnkiConnect. */
const anki = {
	decks: ['Default', 'MCAT', 'MCAT::Biochemistry', 'MCAT::Chem-Phys'],
	cards: [] as { id: number; nid: number; deck: string; ord: number }[],
	revlog: [] as { id: number; cid: number; ease: number; type: number; time: number; deck: string }[],
	added: [] as { id: number; deck: string; model: string; fields: Record<string, string> }[],
	calls: [] as { action: string; params: Record<string, unknown> }[],
	due: [] as { cards: number[]; days: string }[]
};
let nextId = 1_801_000_000_000;

async function handle(action: string, p: Record<string, unknown>): Promise<unknown> {
	anki.calls.push({ action, params: p });
	switch (action) {
		case 'requestPermission':
			return { permission: 'granted', requireApiKey: false, version: 6 };
		case 'version':
			return 6;
		case 'sync':
			return null;
		case 'deckNames':
			return anki.decks;
		case 'findCards': {
			const q = String(p.query);
			const root = /"deck:([^"]+)"/.exec(q)?.[1] ?? '';
			return anki.cards.filter((c) => c.deck === root || c.deck.startsWith(root + '::')).map((c) => c.id);
		}
		case 'findNotes':
			return [];
		case 'notesModTime':
			return [];
		case 'exportPackage':
			await makeAnkiPackage(String(p.path), { variant: 'v1' });
			return true;
		case 'cardReviews':
			return anki.revlog.filter((r) => r.deck === p.deck && r.id > Number(p.startID)).map((r) => [r.id, r.cid, -1, r.ease, 1, 0, 2500, r.time, r.type]);
		case 'insertReviews':
			for (const t of p.reviews as number[][]) anki.revlog.push({ id: t[0], cid: t[1], ease: t[3], type: t[8], time: t[7], deck: anki.cards.find((c) => c.id === t[1])?.deck ?? '?' });
			return null;
		case 'modelNames':
			return ['Basic', 'Basic (and reversed card)', 'Cloze'];
		case 'createDeck':
			if (!anki.decks.includes(String(p.deck))) anki.decks.push(String(p.deck));
			return 1;
		case 'addNotes':
			return (p.notes as { deckName: string; modelName: string; fields: Record<string, string> }[]).map((n) => {
				const id = nextId++;
				anki.added.push({ id, deck: n.deckName, model: n.modelName, fields: n.fields });
				anki.cards.push({ id: id + 500_000_000, nid: id, deck: n.deckName, ord: 0 });
				return id;
			});
		case 'notesInfo':
			return (p.notes as number[]).map((id) => ({ noteId: id, cards: anki.cards.filter((c) => c.nid === id).map((c) => c.id) }));
		case 'cardsInfo':
			return (p.cards as number[]).map((id) => {
				const c = anki.cards.find((x) => x.id === id);
				return c ? { cardId: c.id, note: c.nid, ord: c.ord, deckName: c.deck } : {};
			});
		case 'setDueDate':
			anki.due.push({ cards: p.cards as number[], days: String(p.days) });
			return true;
		case 'updateNoteFields':
			return null;
		default:
			throw new Error(`unsupported action ${action}`);
	}
}

const fakeFetch = (async (_url: unknown, init?: { body?: unknown }) => {
	const req = JSON.parse(String(init?.body ?? '{}')) as { action: string; params?: Record<string, unknown> };
	try {
		return Response.json({ result: await handle(req.action, req.params ?? {}), error: null });
	} catch (err) {
		return Response.json({ result: null, error: (err as Error).message });
	}
}) as typeof fetch;

beforeAll(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
	m = {
		config: await import('../config'),
		db: await import('../db'),
		schema: await import('../db/schema'),
		instance: await import('../instance'),
		cards: await import('../cards'),
		connect: await import('./connect'),
		sync: await import('./sync')
	};
	m.config.ensureDataDirs();
	m.db.openLocalDatabase();
	await m.db.openMainDatabase();
	m.instance.ensureInstance();
	m.db.db().insert(m.schema.user).values({ id: 1, passwordHash: 'x', timeZone: 'America/Chicago', dayStartHour: 4, createdAt: T0, updatedAt: T0 }).run();
	m.connect.setAnkiFetch(fakeFetch);
	// The fake collection holds the fixture deck's cards and reviews.
	const content = deckContent('v1');
	for (const c of content.cards) anki.cards.push({ id: c.id, nid: c.nid, deck: 'MCAT::Biochemistry', ord: c.ord });
	for (const r of content.revlog) anki.revlog.push({ id: r.id, cid: r.cid, ease: r.ease, type: r.type, time: r.time, deck: 'MCAT::Biochemistry' });
});

afterAll(async () => {
	vi.useRealTimers();
	await (await import('../ai/indexer')).stopIndexer();
	(await import('../ai/index-db')).closeIndexDb();
	m?.db.closeDatabases();
	fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

let seq = 0;
function review(cardId: string, rating: number) {
	const c = m.cards.reviewCard(cardId)!;
	return m.cards.submitReview({ cardId, rating, eventId: c.eventId, timeTakenMs: 7000, deviceId: 'pc', deviceSeq: ++seq, baseRev: c.rev });
}
const count = (sql: string, ...a: unknown[]) => (m.db.sqlite().prepare(sql).get(...a) as { n: number }).n;

describe('Anki sync', () => {
	let ownCardId = '';

	it('first sync: reads the deck in with its history, sends cards and reviews made here', async () => {
		m.connect.setAnkiConnectConfig({ ankiWeb: true, pushOwnCards: true, pushDeck: 'Medicus', auto: false });
		m.sync.setSyncDecks(['MCAT']);
		const own = m.cards.createNote({ kind: 'basic', fields: { Front: 'What does **ATP synthase** use?', Back: 'The proton gradient' }, aamcCode: '1D' });
		ownCardId = own.cardIds[0];
		vi.setSystemTime(T0 + 3600_000);
		review(ownCardId, 3);
		// A review done on the phone, waiting in Anki.
		const kinase = deckContent('v1').cards[0].id;
		anki.revlog.push({ id: T0 + 1800_000, cid: kinase, ease: 3, type: 1, time: 5000, deck: 'MCAT::Biochemistry' });

		vi.setSystemTime(T0 + 2 * 3600_000);
		const rep = await m.sync.runSync();
		expect(rep.error).toBeNull();
		expect(rep.ok).toBe(true);
		expect(rep.ankiWeb).toBe('synced');
		expect(anki.calls.filter((c) => c.action === 'sync')).toHaveLength(2);
		expect(rep.decksRead).toEqual(['MCAT']);
		expect(rep.notesAdded).toBeGreaterThan(5);
		// The phone review came in once (the package's own history is already there and isn't counted twice).
		expect(count("SELECT count(*) AS n FROM review_event WHERE device_id = 'anki' AND device_seq = ?", T0 + 1800_000)).toBe(1);
		// Our card went to Anki as HTML, with its review and due date.
		expect(rep.cardsPushed).toBe(1);
		expect(anki.added[0].deck).toBe('Medicus');
		expect(anki.added[0].fields.Front).toContain('<strong>ATP synthase</strong>');
		expect(rep.reviewsPushed).toBe(1);
		expect(count('SELECT count(*) AS n FROM anki_push')).toBe(1);
		expect(anki.due.flatMap((d) => d.cards)).toContain(anki.cards.find((c) => c.nid === anki.added[0].id)!.id);
		// Every card from the deck knows its Anki id.
		expect(count("SELECT count(*) AS n FROM card WHERE deck LIKE 'MCAT::%' AND anki_card_id IS NULL")).toBe(0);
		expect(m.cards.verifyReplay().mismatches).toEqual([]);
	});

	it('next sync: only new reviews come in, nothing this app wrote comes back, nothing is sent twice', async () => {
		// Pretend the Medicus deck was read in already (the stand-in can't export it).
		m.db.sqlite().prepare("UPDATE anki_sync_deck SET last_import_at = ? WHERE deck = 'Medicus'").run(Date.now());
		m.db.sqlite().prepare("INSERT OR IGNORE INTO anki_sync_deck (deck, enabled, last_revlog_id, last_import_at, created_at, updated_at) VALUES ('Medicus', 1, 0, ?, ?, ?)").run(Date.now(), Date.now(), Date.now());
		const ankiOwn = anki.cards.find((c) => c.nid === anki.added[0].id)!;
		// On the phone: one review of the card made here.
		vi.setSystemTime(T0 + 30 * 3600_000);
		anki.revlog.push({ id: T0 + 29 * 3600_000, cid: ankiOwn.id, ease: 4, type: 1, time: 4000, deck: 'Medicus' });
		const reviewsBefore = count('SELECT count(*) AS n FROM review_event');
		const rep = await m.sync.runSync();
		expect(rep.error).toBeNull();
		expect(rep.decksRead).toEqual([]);
		expect(rep.reviewsPulled).toBe(1);
		expect(rep.reviewsPushed).toBe(0);
		expect(rep.cardsPushed).toBe(0);
		expect(count('SELECT count(*) AS n FROM review_event')).toBe(reviewsBefore + 1);
		expect(count('SELECT count(*) AS n FROM review_event WHERE card_id = ?', ownCardId)).toBe(2);
		expect(m.cards.verifyReplay().mismatches).toEqual([]);
	});

	it('says plainly when Anki isn’t open', async () => {
		m.connect.setAnkiFetch((async () => {
			throw new TypeError('fetch failed');
		}) as typeof fetch);
		const rep = await m.sync.runSync();
		expect(rep.ok).toBe(false);
		expect(rep.error).toMatch(/Open Anki/);
		m.connect.setAnkiFetch(fakeFetch);
	});
});
