// M3 acceptance checks: Anki packages (old and new formats) import with a report,
// re-imports update without duplicating, local edits are asked about, review
// history carries over exactly once (and is never invented), and repeatedly
// failed cards are flagged as leeches without being changed.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { makeAnkiPackage } from '../../../../tests/fixtures/make-anki-packages.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-anki-'));
process.env.CORTEX_DATA_DIR = dir;
process.env.CORTEX_ENV_LOADED = '1';

type Mods = {
	config: typeof import('../config');
	db: typeof import('../db');
	schema: typeof import('../db/schema');
	instance: typeof import('../instance');
	cards: typeof import('../cards');
	importer: typeof import('./importer');
	media: typeof import('./media');
	template: typeof import('./template');
	exportimport: typeof import('../exportimport');
};
let m: Mods;
const T0 = Date.parse('2026-10-20T15:00:00Z');
const pkgDir = path.join(dir, 'packages');

beforeAll(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
	m = {
		config: await import('../config'),
		db: await import('../db'),
		schema: await import('../db/schema'),
		instance: await import('../instance'),
		cards: await import('../cards'),
		importer: await import('./importer'),
		media: await import('./media'),
		template: await import('./template'),
		exportimport: await import('../exportimport')
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
	fs.mkdirSync(pkgDir, { recursive: true });
});

afterAll(() => {
	vi.useRealTimers();
	m?.db.closeDatabases();
	fs.rmSync(dir, { recursive: true, force: true });
});

let n = 0;
async function runImport(options: Record<string, unknown>, decisions?: Partial<import('./importer').ImportDecisions>) {
	const id = `t${++n}`;
	const file = path.join(pkgDir, `${id}.apkg`);
	await makeAnkiPackage(file, options);
	const work = path.join(dir, 'work', id);
	const analysis = await m.importer.analyzePackage(file, work);
	m.db.db().insert(m.schema.ankiImport).values({ id, fileName: `${id}.apkg`, fileSize: 1, fileHash: 'x', status: 'ready', analysis, createdAt: T0, updatedAt: T0 }).run();
	const result = await m.importer.applyPackage(id, file, work, { conflicts: {}, conflictDefault: 'keep', useDeckRetention: false, ...decisions });
	return { analysis, result };
}

const count = (sql: string, ...args: unknown[]) => (m.db.sqlite().prepare(sql).get(...args) as { n: number }).n;
const noteByGuid = (guid: string) => m.db.sqlite().prepare('SELECT * FROM note WHERE guid = ?').get(guid) as { id: string; fields: string; rev: number };
const cardsOf = (guid: string) =>
	m.db.sqlite().prepare('SELECT c.* FROM card c JOIN note n ON n.id = c.note_id WHERE n.guid = ? ORDER BY c.ord').all(guid) as {
		id: string;
		ord: number;
		suspended: number;
		leech: number;
		lapses: number;
		deck: string | null;
		state: number;
		position: number | null;
	}[];

describe('Anki import (M3)', () => {
	let first: Awaited<ReturnType<typeof runImport>>;

	it('imports an older-format package with a report of anything unsupported', async () => {
		first = await runImport({ format: 'legacy' });
		const a = first.analysis;
		expect(a.version).toBe('legacy2');
		expect(a.plan.newNotes).toBe(11); // image occlusion notes included
		expect(a.plan.skippedImageOcclusion).toBe(0);
		const kinds = a.unsupported.map((u) => u.kind);
		expect(kinds).toEqual(expect.arrayContaining(['image_occlusion', 'type_answer', 'deck_options']));
		// Card scripts run (inside the card), so they're counted, not reported as unsupported.
		expect(kinds).not.toContain('script');
		expect(a.scriptNotes).toBeGreaterThan(0);
		expect(a.noteTypes.some((t) => t.scripts)).toBe(true);
		// Tags come in with the notes, and the report says so.
		expect(a.tags!.tagged).toBeGreaterThan(0);
		expect(a.tags!.distinct).toBeGreaterThan(0);
		expect(a.tags!.groups.length).toBeGreaterThan(0);
		expect(a.unsupported.find((u) => u.kind === 'image_occlusion')!.count).toBe(2);
		expect(a.history.status).toBe('included');
		expect(a.history.notReviews).toBe(1); // the manual reschedule entry
		expect(a.retention.deck).toBe(0.85);
		expect(a.media.files).toBe(7);

		const r = first.result;
		expect(r.notesAdded).toBe(11);
		expect(r.cardsAdded).toBe(15);
		expect(r.mediaAdded).toBe(7);
		expect(r.reviewsImported).toBe(a.history.reviews);
		expect(count("SELECT count(*) AS n FROM note WHERE origin = 'anki'")).toBe(11);
		expect(cardsOf('km-guid')).toHaveLength(2);
		expect(cardsOf('kinase-guid')[0].deck).toBe('MCAT::Biochemistry');
		expect(cardsOf('image-guid')[0].suspended).toBe(1);
		expect(cardsOf('io-guid')).toHaveLength(1);
		expect(cardsOf('io-native-guid')).toHaveLength(2);
	});

	it('keeps each new card’s place in the deck’s own order', () => {
		// The fixture numbers new cards in the reverse of the order their notes were made.
		const nested = cardsOf('nested-guid');
		const typing = cardsOf('typing-guid');
		expect(nested[0].position).not.toBeNull();
		expect(typing[0].position!).toBeLessThan(nested[0].position!);
		// Cards that have been studied have no new-card position.
		expect(cardsOf('kinase-guid')[0].position).toBeNull();
	});

	it('flags a card failed eight times as a leech, without suspending or rescheduling it', () => {
		const [leech] = cardsOf('leech-guid');
		expect(leech.lapses).toBe(8);
		expect(leech.leech).toBe(1);
		expect(leech.suspended).toBe(0);
		expect(cardsOf('kinase-guid')[0].leech).toBe(0);
	});

	it('replaying all review events reproduces every card, including imported history', () => {
		const check = m.cards.verifyReplay();
		expect(check.mismatches).toEqual([]);
		expect(check.events).toBe(first.result.reviewsImported);
	});

	it('renders imported cards the way Anki does, keeping the deck’s scripts for the sealed frame', () => {
		const glyco = cardsOf('glyco-guid');
		const c1 = m.cards.reviewCard(glyco[0].id)!;
		expect(c1.anki?.css).toContain('.cloze');
		expect(c1.front).toContain('[...]');
		expect(c1.front).toContain('cytoplasm');
		expect(c1.back).toContain('Glycolysis');
		const c2 = m.cards.reviewCard(glyco[1].id)!;
		expect(c2.front).toContain('[cell compartment]');

		const nested = cardsOf('nested-guid');
		expect(m.cards.reviewCard(nested[1].id)!.front).toMatch(/Oxidative <span class="cloze"[^>]*>\[\.\.\.\]<\/span>/);

		const hh = m.cards.reviewCard(cardsOf('hh-guid')[0].id)!;
		expect(hh.back).toContain('class="katex"');
		expect(hh.anki?.math).toBe(true);

		const img = m.cards.reviewCard(cardsOf('image-guid')[0].id)!;
		expect(img.front).toContain('<img src="cell.png">');
		expect(img.back).toContain('<audio class="sound" controls preload="none" src="pronounce.mp3">');

		const scripted = m.cards.reviewCard(cardsOf('script-guid')[0].id)!;
		expect(scripted.front).toContain('<script>document.body.classList.add("scripted")</script>');
		expect(scripted.front).toContain('onclick="alert(1)"');
		expect(scripted.front).toContain('<details class="hint">');
		expect(scripted.anki?.mediaBase).toMatch(/^\/api\/media\/k\/[\w-]{32}\/$/);

		const typing = m.cards.reviewCard(cardsOf('typing-guid')[0].id)!;
		expect(typing.front).not.toContain('[[type:');
		expect(typing.back).toContain('<div class="typed-answer">Insulin</div>');

		expect(m.media.mediaFile('cell.png')).not.toBeNull();
	});

	it('renders image occlusion masks the way Anki’s reviewer expects them', () => {
		const [c1, c2] = cardsOf('io-native-guid');
		const q1 = m.cards.reviewCard(c1.id)!;
		// Question side of card 1: its mask is the active one, the other is inactive.
		expect(q1.front).toMatch(/<div class="cloze" data-ordinal="1" data-shape="rect" data-left=".1" data-top=".2" data-width=".3" data-height=".25" data-occludeinactive="1"><\/div>/);
		expect(q1.front).toMatch(/<div class="cloze-inactive" data-ordinal="2" data-shape="ellipse"[^>]* data-rx=".1" data-ry=".08"/);
		expect(q1.front).toContain('anki.imageOcclusion.setup()');
		expect(q1.front).toContain('<canvas id="image-occlusion-canvas"></canvas>');
		// Answer side: the active mask becomes a highlight; the toggle button is there.
		expect(q1.back).toContain('class="cloze-highlight" data-ordinal="1"');
		expect(q1.back).toContain('<button id="toggle">Toggle Masks</button>');
		const q2 = m.cards.reviewCard(c2.id)!;
		expect(q2.front).toContain('class="cloze" data-ordinal="2" data-shape="ellipse"');
		// Image occlusion data isn't shown as text in lists.
		expect(m.cards.listCards({ deck: 'MCAT::Biochemistry', limit: 200 }).items.some((i) => /image-occlusion/.test(i.preview))).toBe(false);
	});

	it('serves card media through the frame’s daily key, and only with a valid key', async () => {
		const key = /\/k\/([^/]+)\//.exec(m.media.mediaBase())![1];
		expect(m.media.mediaKeyValid(key)).toBe(true);
		expect(m.media.mediaKeyValid(key.replace(/^./, (ch) => (ch === 'A' ? 'B' : 'A')))).toBe(false);
		expect(m.media.mediaKeyValid(key, Date.now() + 86_400_000)).toBe(true); // still fine the next day
		expect(m.media.mediaKeyValid(key, Date.now() + 3 * 86_400_000)).toBe(false);
		const res = m.media.mediaResponse('cell.png', new Request('http://x/'), true);
		expect(res.status).toBe(200);
		expect(res.headers.get('access-control-allow-origin')).toBe('*');
		expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
	});

	it('re-importing the same package changes nothing and duplicates nothing', async () => {
		const notes = count('SELECT count(*) AS n FROM note');
		const events = count('SELECT count(*) AS n FROM review_event');
		const again = await runImport({ format: 'legacy' });
		expect(again.analysis.plan.newNotes).toBe(0);
		expect(again.analysis.plan.unchangedNotes).toBe(11);
		expect(again.analysis.history.alreadyImported).toBe(again.analysis.history.reviews);
		expect(again.result.reviewsImported).toBe(0);
		expect(again.result.mediaAdded).toBe(0);
		expect(count('SELECT count(*) AS n FROM note')).toBe(notes);
		expect(count('SELECT count(*) AS n FROM review_event')).toBe(events);
	});

	it('imports the newer compressed format and updates changed notes and new reviews', async () => {
		const events = count('SELECT count(*) AS n FROM review_event');
		const v2 = await runImport({ format: 'latest', variant: 'v2' });
		expect(v2.analysis.version).toBe('latest');
		expect(v2.analysis.plan.newNotes).toBe(1);
		expect(v2.analysis.plan.updatedNotes).toBe(1);
		expect(v2.result.notesUpdated).toBe(1);
		expect(v2.result.reviewsImported).toBe(2);
		expect(JSON.parse(noteByGuid('kinase-guid').fields).Back).toContain('phosphotransferase');
		expect(count('SELECT count(*) AS n FROM review_event')).toBe(events + 2);
		expect(m.cards.verifyReplay().mismatches).toEqual([]);
	});

	it('asks before overwriting a card edited here, and keeps or replaces it as chosen', async () => {
		const km = noteByGuid('km-guid');
		m.cards.updateNote(km.id, { kind: 'anki', fields: { Front: 'K<sub>m</sub>', Back: 'My own wording' }, tags: [] });
		const v3 = await runImport({ format: 'latest', variant: 'v3' });
		expect(v3.analysis.plan.conflicts).toBe(1);
		expect(v3.analysis.conflicts[0].guid).toBe('km-guid');
		expect(v3.analysis.conflicts[0].local.Back).toBe('My own wording');
		expect(v3.result.conflictsKept).toBe(1);
		expect(JSON.parse(noteByGuid('km-guid').fields).Back).toBe('My own wording');

		// Same deck again: already decided, so no question this time.
		const again = await runImport({ format: 'latest', variant: 'v3' });
		expect(again.analysis.plan.conflicts).toBe(0);
		expect(again.analysis.plan.keptLocal).toBe(1);

		// A deck version the owner chooses to take.
		const back = await runImport({ format: 'latest', variant: 'v2' }, { conflictDefault: 'overwrite' });
		expect(back.analysis.plan.conflicts).toBe(1);
		expect(back.result.conflictsOverwritten).toBe(1);
		expect(JSON.parse(noteByGuid('km-guid').fields).Back).not.toBe('My own wording');
	});

	it('says so when a package has no review history, and invents none', async () => {
		const fresh = path.join(pkgDir, 'nohist.apkg');
		await makeAnkiPackage(fresh, { format: 'legacy', variant: 'nohistory' });
		const analysis = await m.importer.analyzePackage(fresh, path.join(dir, 'work', 'nohist'));
		expect(analysis.history.status).toBe('none');
		expect(analysis.history.message).toMatch(/no review history/i);
		expect(analysis.history.reviews).toBe(0);
	});

	it('reports media the package left out', async () => {
		const file = path.join(pkgDir, 'nomedia.apkg');
		await makeAnkiPackage(file, { format: 'legacy', withMedia: false });
		// Media from the earlier imports is already here, so nothing is reported missing...
		const a = await m.importer.analyzePackage(file, path.join(dir, 'work', 'nomedia'));
		expect(a.media.files).toBe(0);
		expect(a.media.missingCount).toBe(0);
		// ...but unknown files are.
		m.db.sqlite().prepare("DELETE FROM media WHERE name = 'cell.png'").run();
		const b = await m.importer.analyzePackage(file, path.join(dir, 'work', 'nomedia2'));
		expect(b.media.missing.map((x) => x.name)).toEqual(['cell.png']);
		expect(b.media.notIncluded).toBe(true);
	});

	it('keeps a second deck’s note type apart when it shares an id but not the fields', async () => {
		const before = (m.db.sqlite().prepare("SELECT fields FROM note_type WHERE id = 'anki-1700000000101'").get() as { fields: string }).fields;
		const clash = await runImport({ format: 'latest', variant: 'clash' });
		expect(clash.result.notesAdded).toBe(1);
		const n = m.db.sqlite().prepare("SELECT note_type_id FROM note WHERE guid = 'clash-guid'").get() as { note_type_id: string };
		expect(n.note_type_id).toMatch(/^anki-1700000000101-[0-9a-f]{8}$/);
		// The first deck's Basic note type is unchanged, and so are its notes' cards.
		expect((m.db.sqlite().prepare("SELECT fields FROM note_type WHERE id = 'anki-1700000000101'").get() as { fields: string }).fields).toBe(before);
		expect(m.cards.reviewCard(cardsOf('kinase-guid')[0].id)!.back).toContain('kinase');
		expect(m.cards.reviewCard(cardsOf('clash-guid')[0].id)!.back).toContain('<div class="source">Biology 2e, ch. 40</div>');
	});

	it('exports Anki notes in the cards CSV without failing', () => {
		const csv = m.exportimport.cardsCsv();
		expect(csv).toContain('kinase-guid');
		expect(csv).toContain('Basic (and reversed card)');
	});
});

describe('Anki templates', () => {
	it('handles conditionals, special fields and unknown fields', () => {
		const t = {
			name: 'Custom',
			kind: 'standard' as const,
			fields: ['Front', 'Back', 'Extra'],
			templates: [{ name: 'Card 1', front: '{{Front}}{{#Extra}}<i>{{Extra}}</i>{{/Extra}}{{^Extra}}no extra{{/Extra}} [{{Deck}}|{{Subdeck}}|{{Tags}}]', back: '{{FrontSide}}<hr id=answer>{{text:Back}}' }]
		};
		const r = m.template.renderAnkiCard(t, { Front: 'Q', Back: '<b>A</b>', Extra: '' }, 0, { tags: ['x', 'y'], deck: 'MCAT::Bio' });
		expect(r.question).toContain('no extra');
		expect(r.question).toContain('[MCAT::Bio|Bio|x y]');
		expect(r.answer).toContain('<hr id="answer">');
		expect(r.answer).toMatch(/<hr id="answer">A$/);
		const bad = m.template.renderAnkiCard({ ...t, templates: [{ name: 'c', front: '{{Missing}}', back: '' }] }, { Front: 'Q' }, 0, { tags: [], deck: null });
		expect(bad.question).toContain('no field called');
	});
});
