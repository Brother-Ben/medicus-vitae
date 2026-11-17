// Acceptance checks from the spec (M1, M2) against the real server modules and a
// throwaway data folder.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-test-'));
process.env.CORTEX_DATA_DIR = dir;
process.env.CORTEX_ENV_LOADED = '1';

type Mods = {
	config: typeof import('./config');
	db: typeof import('./db');
	schema: typeof import('./db/schema');
	instance: typeof import('./instance');
	cards: typeof import('./cards');
	fsrs: typeof import('./fsrs');
	reading: typeof import('./reading');
	practice: typeof import('./practice');
	stats: typeof import('./stats');
	planner: typeof import('./planner');
	snapshots: typeof import('./snapshots');
	exportimport: typeof import('./exportimport');
	files: typeof import('./files');
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
		reading: await import('./reading'),
		practice: await import('./practice'),
		stats: await import('./stats'),
		planner: await import('./planner'),
		snapshots: await import('./snapshots'),
		exportimport: await import('./exportimport'),
		files: await import('./files')
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

afterAll(() => {
	vi.useRealTimers();
	m?.db.closeDatabases();
	fs.rmSync(dir, { recursive: true, force: true });
});

let seq = 0;
function review(cardId: string, rating: number, confidence: 'guess' | 'unsure' | 'sure' | null = null) {
	const c = m.cards.reviewCard(cardId)!;
	return { result: m.cards.submitReview({ cardId, rating, confidence, eventId: c.eventId, timeTakenMs: 8000, deviceId: 'test', deviceSeq: ++seq, baseRev: c.rev }), eventId: c.eventId };
}

describe('M1: cards and scheduling', () => {
	it('replaying all stored review events reproduces identical card states', () => {
		const basic = m.cards.createNote({ kind: 'basic', fields: { Front: 'Km?', Back: 'Half Vmax' }, aamcCode: '1A' });
		const rev = m.cards.createNote({ kind: 'basic_reversed', fields: { Front: 'ATP synthase', Back: 'Uses the proton gradient' }, aamcCode: '1D' });
		const cloze = m.cards.createNote({ kind: 'cloze', fields: { Text: '{{c1::Rods}} see dim light; {{c2::cones}} see color.' }, aamcCode: '6A' });
		const ids = [...basic.cardIds, ...rev.cardIds, ...cloze.cardIds];
		expect(ids).toHaveLength(5);
		const ratings = [3, 3, 1, 3, 4, 2, 3];
		let t = T0;
		for (const r of ratings) {
			for (const id of ids) {
				vi.setSystemTime((t += 7 * 60_000));
				review(id, r);
			}
			t += 2 * 86_400_000;
		}
		vi.setSystemTime(t);
		const v = m.cards.verifyReplay();
		expect(v.events).toBe(ratings.length * ids.length);
		expect(v.mismatches).toEqual([]);
	});

	it('stores confidence but schedules exactly like plain FSRS', () => {
		const n = m.cards.createNote({ kind: 'basic', fields: { Front: 'q', Back: 'a' } });
		const before = m.cards.cardsByIds(n.cardIds)[0];
		const { eventId } = review(n.cardIds[0], 3, 'guess');
		const after = m.cards.cardsByIds(n.cardIds)[0];
		const ev = m.db.db().select().from(m.schema.reviewEvent).all().find((e) => e.id === eventId)!;
		expect(ev.confidence).toBe('guess');
		const plain = m.fsrs.applyRating(m.fsrs.schedState(before), m.fsrs.currentParams(0.9), ev.reviewedAt, 3, eventId);
		expect(m.fsrs.sameState(plain, m.fsrs.schedState(after))).toBe(true);
	});

	it('counts reviews after midnight but before the day-start hour toward the previous day', () => {
		const n = m.cards.createNote({ kind: 'basic', fields: { Front: 'late', Back: 'night' } });
		vi.setSystemTime(Date.parse('2026-11-05T07:30:00Z')); // 01:30 in Chicago
		const { eventId } = review(n.cardIds[0], 3);
		const ev = m.db.db().select().from(m.schema.reviewEvent).all().find((e) => e.id === eventId)!;
		expect(ev.studyDay).toBe('2026-11-04');
	});

	it('saves a review once even if it is sent twice, and refuses a stale one', () => {
		const n = m.cards.createNote({ kind: 'basic', fields: { Front: 'dup', Back: 'x' } });
		const c = m.cards.reviewCard(n.cardIds[0])!;
		const input = { cardId: c.cardId, rating: 3, eventId: c.eventId, timeTakenMs: 1000, deviceId: 't', deviceSeq: ++seq, baseRev: c.rev };
		expect(m.cards.submitReview(input).status).toBe('saved');
		expect(m.cards.submitReview(input).status).toBe('duplicate');
		const again = m.cards.reviewCard(n.cardIds[0])!;
		expect(m.cards.submitReview({ ...input, eventId: again.eventId, baseRev: 0, deviceSeq: ++seq }).status).toBe('conflict');
	});
});

describe('M1: highlight to card', () => {
	it('keeps a durable link to the passage, and stays readable if the source goes missing', () => {
		const pdf = Buffer.from('%PDF-1.4 test');
		const tmp = path.join(m.config.config.paths.tmp, 'fake.pdf');
		fs.writeFileSync(tmp, pdf);
		const hash = 'a'.repeat(64);
		m.files.commitTmpFile(tmp, hash);
		const now = Date.now();
		m.db.db().insert(m.schema.document).values({ id: 'doc1', title: 'Biology 2e', fileHash: hash, fileName: 'bio.pdf', fileSize: pdf.length, status: 'ready', pageCount: 10, currentVersionId: 'v1', createdAt: now, updatedAt: now }).run();
		m.db.db().insert(m.schema.documentVersion).values({ id: 'v1', documentId: 'doc1', extractionVersion: 'test', status: 'ready', pageCount: 10, createdAt: now }).run();

		const anchor = { documentId: 'doc1', versionId: 'v1', page: 4, kind: 'text' as const, rects: [[0.1, 0.2, 0.6, 0.23]], textStart: 10, textEnd: 50, exact: 'Enzymes lower the activation energy' };
		const { noteId, anchorId } = m.cards.createNoteFromSelection(anchor, { kind: 'basic', fields: { Front: 'What do enzymes lower?', Back: 'Activation energy' } });
		const view = m.cards.noteForEdit(noteId)!;
		expect(view.source?.id).toBe(anchorId);
		expect(view.source?.page).toBe(4);
		expect(view.source?.available).toBe(true);

		fs.rmSync(m.files.storedFilePath(hash));
		const missing = m.cards.noteForEdit(noteId)!;
		expect(missing.source?.available).toBe(false);
		expect(missing.source?.exact).toBe('Enzymes lower the activation energy');
		expect(missing.fields.Front).toBe('What do enzymes lower?');
	});

	it('creates nothing when the passage link is invalid (cancel-safe)', () => {
		const before = m.db.db().select().from(m.schema.note).all().length;
		expect(() =>
			m.cards.createNoteFromSelection({ documentId: 'doc1', versionId: 'v1', page: 999, kind: 'text', rects: [[0, 0, 1, 1]], exact: 'x' }, { kind: 'basic', fields: { Front: 'q', Back: 'a' } })
		).toThrow();
		expect(m.db.db().select().from(m.schema.note).all().length).toBe(before);
	});
});

describe('M2: mistakes, evidence, planning', () => {
	it('moves a mistake through open → repair → retest → resolved, and a failed retest reopens it', () => {
		const id = m.practice.createMistake({ sourceType: 'external', reason: 'content_gap', aamcCode: '1A', summary: 'Noncompetitive inhibition' });
		expect(() => m.practice.logRetest(id, { correct: true })).toThrow();
		m.practice.startRepair(id);
		m.practice.completeRepair(id, { explanation: 'It binds away from the active site, so Vmax drops.', passageRevisited: true, retestInDays: 2 });
		m.practice.logRetest(id, { correct: false });
		let d = m.practice.mistakeDetail(id).mistake;
		expect(d.state).toBe('open');
		expect(d.reopenedCount).toBe(1);
		m.practice.startRepair(id);
		m.practice.completeRepair(id, { explanation: 'Extra substrate cannot displace it.', passageRevisited: true });
		m.practice.logRetest(id, { correct: true, externalRef: 'UWorld 123' });
		d = m.practice.mistakeDetail(id).mistake;
		expect(d.state).toBe('resolved');
		expect(m.practice.mistakeDetail(id).attempts).toHaveLength(2);
	});

	it('keeps evidence types separate and shows "not enough data" below the threshold', () => {
		const today = new Date(Date.now()).toISOString().slice(0, 10);
		m.practice.createPracticeSet({ date: today, source: 'UWorld', aamcCode: '4B', total: 12, correct: 9 });
		m.practice.createPracticeSet({ date: today, source: 'UWorld', aamcCode: '5D', total: 4, correct: 1 });
		const cells = m.stats.heatmap().flatMap((r) => r.cells);
		const fluids = cells.find((c) => c.code === '4B')!;
		expect(fluids.practice.enough).toBe(true);
		expect(fluids.practice.value).toBeCloseTo(0.75);
		expect(fluids.recall.enough).toBe(false);
		const molecules = cells.find((c) => c.code === '5D')!;
		expect(molecules.practice.enough).toBe(false);
		expect(molecules.practice.value).toBeNull();
	});

	it('builds a time-budget session that fits and explains each item', () => {
		const plan = m.planner.buildSession(20);
		expect(plan.items.length).toBeGreaterThan(0);
		expect(plan.planned).toBeLessThanOrEqual(22);
		for (const item of plan.items) expect(item.why.length).toBeGreaterThan(20);
	});
});

describe('M2: snapshots and export', () => {
	it('makes a self-contained snapshot and skips when nothing changed', async () => {
		const meta = await m.snapshots.createSnapshot('manual');
		expect(m.snapshots.listSnapshots().some((s) => s.id === meta.id)).toBe(true);
		expect(m.snapshots.changedSince(['manual'])).toBe(false);
		m.cards.createNote({ kind: 'basic', fields: { Front: 'after', Back: 'snapshot' } });
		expect(m.snapshots.changedSince(['manual'])).toBe(true);
		const leftovers = fs.readdirSync(m.config.config.paths.snapshots).filter((f) => /-(wal|shm)$|\.tmp/.test(f));
		expect(leftovers).toEqual([]);
	});

	it('restores a full export into a fresh installation with nothing missing', async () => {
		const tables = ['note', 'card', 'review_event', 'anchor', 'mistake', 'mistake_event', 'attempt', 'practice_set', 'document', 'scheduler_config', 'user'];
		const count = () => Object.fromEntries(tables.map((t) => [t, (m.db.sqlite().prepare(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n]));
		const before = count();
		const { stream } = await m.exportimport.buildExport();
		const zipPath = path.join(os.tmpdir(), `cortex-export-test-${Date.now()}.zip`);
		await new Promise<void>((resolve, reject) => stream.pipe(fs.createWriteStream(zipPath)).on('finish', () => resolve()).on('error', reject));

		// Wipe to a fresh installation.
		m.db.closeMainDatabase();
		for (const f of fs.readdirSync(dir)) if (f.startsWith('cortex.sqlite')) fs.rmSync(path.join(dir, f));
		await m.db.openMainDatabase();
		m.instance.ensureInstance();
		expect((m.db.sqlite().prepare('SELECT count(*) AS n FROM card').get() as { n: number }).n).toBe(0);

		await m.exportimport.restoreFromExport(zipPath);
		expect(count()).toEqual(before);
		expect(m.cards.verifyReplay().mismatches).toEqual([]);
		fs.rmSync(zipPath, { force: true });
	});
});
