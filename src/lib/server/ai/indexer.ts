import { createHash } from 'node:crypto';
import { setImmediate as yieldToServer } from 'node:timers/promises';
import { kindForNoteType, noteText } from '../../cards';
import { config } from '../config';
import { isOpen, sqlite } from '../db';
import { embedPassages, embedStatus, stopEmbedding, vectorBuffer } from './embed';
import { cleanPassage, findFigures, splitPage } from './chunking';
import { deleteChunks, indexDb, indexStats, metaGet, metaSet, vectorsAvailable } from './index-db';

// Keeps the search index in step with the library: new books are split into
// passages, figures found by caption, the owner's notes and cards added, and
// anything deleted or changed replaced. Then passages without an embedding get
// one. Runs in the background on every device (the index is per device), a
// little at a time so reviews and reading stay quick.

export interface IndexerState {
	phase: 'idle' | 'indexing' | 'embedding' | 'error';
	done: number;
	total: number;
	message: string;
	error: string | null;
	lastRunAt: number | null;
}

export const indexerState: IndexerState = { phase: 'idle', done: 0, total: 0, message: '', error: null, lastRunAt: null };

let running: Promise<void> | null = null;
let again = false;
let stopped = false;
let retryAfter = 0;

const sha1 = (s: string) => createHash('sha1').update(s).digest('hex');

/** Asks for an index pass (soon, in the background). Safe to call often. */
export function requestIndex() {
	if (stopped) return;
	if (running) {
		again = true;
		return;
	}
	running = run().finally(() => {
		running = null;
		if (again && !stopped) {
			again = false;
			setTimeout(requestIndex, 2_000).unref();
		}
	});
}

/** Lets a test (or the speed check) wait for the current pass. */
export async function indexIdle() {
	while (running) await running;
}

/** Stops after the current step; the embedding workers finish their batch and exit. */
export async function stopIndexer() {
	stopped = true;
	await stopEmbedding();
}

export function resumeIndexer() {
	stopped = false;
}

let lastSeq = -1;

/** Called every minute: re-index if the owner's data changed. */
export function indexTick() {
	if (!isOpen()) return;
	try {
		const seq = (sqlite().prepare('SELECT write_seq FROM instance WHERE id = 1').get() as { write_seq: number } | undefined)?.write_seq ?? 0;
		const stats = indexStats();
		if (seq !== lastSeq || (vectorsAvailable() && stats.total > stats.embedded)) {
			lastSeq = seq;
			if (Date.now() >= retryAfter) requestIndex();
		}
	} catch {
		// the database may be swapping (standby refresh); try next minute
	}
}

async function run() {
	indexerState.error = null;
	try {
		indexerState.phase = 'indexing';
		await reconcile();
		if (vectorsAvailable()) {
			indexerState.phase = 'embedding';
			await embedPending();
		}
		indexerState.phase = 'idle';
		indexerState.message = '';
		indexerState.lastRunAt = Date.now();
	} catch (err) {
		indexerState.phase = 'error';
		indexerState.error = err instanceof Error ? err.message : String(err);
		retryAfter = Date.now() + 10 * 60_000;
		console.error('Search index update failed:', err);
	}
}

interface Expected {
	key: string;
	kind: 'page' | 'figure' | 'annotation' | 'card';
	provenance: string;
	docId: string | null;
	versionId: string | null;
	page: number | null;
	textStart: number | null;
	textEnd: number | null;
	rects: number[][] | null;
	refId: string | null;
	section: string | null;
	text: string;
	hash: string;
}

function insertChunks(rows: Expected[]) {
	const db = indexDb();
	const ins = db.prepare(
		`INSERT INTO chunk (key, kind, provenance, doc_id, version_id, page, text_start, text_end, rects, ref_id, section, text, hash, embedded)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
	);
	db.transaction(() => {
		for (const r of rows) {
			ins.run(r.key, r.kind, r.provenance, r.docId, r.versionId, r.page, r.textStart, r.textEnd, r.rects ? JSON.stringify(r.rects) : null, r.refId, r.section, r.text, r.hash);
		}
	})();
}

/** Brings one keyed group of chunks (e.g. all cards) in line with what's expected. */
async function syncGroup(prefix: string, expected: Map<string, Expected>) {
	const db = indexDb();
	const existing = db.prepare(`SELECT id, key, hash FROM chunk WHERE key LIKE ? ESCAPE '\\'`).all(prefix.replace(/[\\%_]/g, (m) => '\\' + m) + '%') as {
		id: number;
		key: string;
		hash: string;
	}[];
	const have = new Map(existing.map((e) => [e.key, e]));
	const remove: number[] = [];
	for (const e of existing) {
		const want = expected.get(e.key);
		if (!want || want.hash !== e.hash) remove.push(e.id);
	}
	deleteChunks(remove);
	const add = [...expected.values()].filter((x) => have.get(x.key)?.hash !== x.hash);
	for (let i = 0; i < add.length; i += 500) {
		insertChunks(add.slice(i, i + 500));
		await yieldToServer();
	}
}

async function reconcile() {
	const main = sqlite();
	const db = indexDb();

	// Books: one pass per document version (pages never change after extraction).
	const versions = main
		.prepare(`SELECT id AS doc_id, current_version_id AS version_id FROM document WHERE status = 'ready' AND current_version_id IS NOT NULL`)
		.all() as { doc_id: string; version_id: string }[];
	const current = new Set(versions.map((v) => v.version_id));
	const indexed = (db.prepare(`SELECT DISTINCT version_id FROM chunk WHERE version_id IS NOT NULL AND kind IN ('page', 'figure')`).pluck().all() as string[]);
	for (const v of indexed) {
		if (!current.has(v)) deleteChunks(db.prepare(`SELECT id FROM chunk WHERE version_id = ? AND key NOT LIKE 'region:%'`).pluck().all(v) as number[]);
	}
	const done = new Set<string>(JSON.parse(metaGet('versions') ?? '[]'));
	for (const v of [...done]) if (!current.has(v)) done.delete(v);
	const todo = versions.filter((v) => !done.has(v.version_id));
	indexerState.total = todo.length;
	indexerState.done = 0;
	for (const v of todo) {
		if (stopped) return;
		indexerState.message = 'Reading your books into the search index';
		deleteChunks(db.prepare(`SELECT id FROM chunk WHERE version_id = ? AND key NOT LIKE 'region:%'`).pluck().all(v.version_id) as number[]);
		const sections = main.prepare('SELECT title, page_start, page_end FROM doc_section WHERE document_id = ? ORDER BY level DESC, position').all(v.doc_id) as {
			title: string;
			page_start: number;
			page_end: number;
		}[];
		const sectionAt = (page: number) => sections.find((s) => page >= s.page_start && page <= s.page_end)?.title ?? null;
		const pageStmt = main.prepare('SELECT page_number, text, items FROM doc_page WHERE version_id = ? AND page_number > ? ORDER BY page_number LIMIT 40');
		let after = 0;
		for (;;) {
			const pages = pageStmt.all(v.version_id, after) as { page_number: number; text: string; items: string }[];
			if (!pages.length) break;
			after = pages[pages.length - 1].page_number;
			const rows: Expected[] = [];
			for (const p of pages) {
				const section = sectionAt(p.page_number);
				for (const span of splitPage(p.text)) {
					const text = cleanPassage(p.text.slice(span.start, span.end));
					rows.push({
						key: `page:${v.version_id}:${p.page_number}:${span.start}`,
						kind: 'page',
						provenance: 'original',
						docId: v.doc_id,
						versionId: v.version_id,
						page: p.page_number,
						textStart: span.start,
						textEnd: span.end,
						rects: null,
						refId: null,
						section,
						text,
						hash: sha1(text)
					});
				}
				let runs: [number, number, number, number, number, number][] = [];
				try {
					runs = JSON.parse(p.items);
				} catch {
					runs = [];
				}
				for (const f of findFigures(p.text, runs)) {
					rows.push({
						key: `fig:${v.version_id}:${p.page_number}:${f.captionStart}`,
						kind: 'figure',
						provenance: 'original',
						docId: v.doc_id,
						versionId: v.version_id,
						page: p.page_number,
						textStart: f.captionStart,
						textEnd: f.captionEnd,
						rects: f.rects,
						refId: null,
						section,
						text: f.caption,
						hash: sha1(f.caption)
					});
				}
			}
			insertChunks(rows);
			await yieldToServer();
			if (stopped) return;
		}
		done.add(v.version_id);
		metaSet('versions', JSON.stringify([...done]));
		indexerState.done++;
	}

	// Figures, tables and equations the owner boxed while reading.
	const regions = new Map<string, Expected>();
	for (const a of main
		.prepare(
			`SELECT a.id, a.document_id, a.version_id, a.page_number, a.rects, a.exact, a.section_title FROM anchor a
			 WHERE a.kind = 'region' AND (
				EXISTS (SELECT 1 FROM highlight h WHERE h.anchor_id = a.id AND h.deleted_at IS NULL) OR
				EXISTS (SELECT 1 FROM annotation n WHERE n.anchor_id = a.id AND n.deleted_at IS NULL) OR
				EXISTS (SELECT 1 FROM note n WHERE n.anchor_id = a.id AND n.deleted_at IS NULL))`
		)
		.all() as { id: string; document_id: string; version_id: string; page_number: number; rects: string; exact: string; section_title: string | null }[]) {
		if (!current.has(a.version_id) || (a.exact ?? '').trim().length < 3) continue;
		regions.set(`region:${a.id}`, {
			key: `region:${a.id}`,
			kind: 'figure',
			provenance: 'original',
			docId: a.document_id,
			versionId: a.version_id,
			page: a.page_number,
			textStart: null,
			textEnd: null,
			rects: JSON.parse(a.rects),
			refId: a.id,
			section: a.section_title,
			text: cleanPassage(a.exact),
			hash: sha1(a.exact + a.rects)
		});
	}
	await syncGroup('region:', regions);

	// The owner's reading notes (never AI-generated ones).
	const notes = new Map<string, Expected>();
	for (const n of main
		.prepare(
			`SELECT an.id, an.body, an.document_id, an.updated_at, a.page_number, a.section_title, a.version_id FROM annotation an
			 LEFT JOIN anchor a ON a.id = an.anchor_id WHERE an.deleted_at IS NULL AND an.origin = 'owner'`
		)
		.all() as { id: string; body: string; document_id: string | null; updated_at: number; page_number: number | null; section_title: string | null; version_id: string | null }[]) {
		const text = cleanPassage(n.body);
		if (text.length < 3) continue;
		notes.set(`ann:${n.id}`, {
			key: `ann:${n.id}`,
			kind: 'annotation',
			provenance: 'owner',
			docId: n.document_id,
			versionId: n.version_id,
			page: n.page_number,
			textStart: null,
			textEnd: null,
			rects: null,
			refId: n.id,
			section: n.section_title,
			text,
			hash: String(n.updated_at)
		});
	}
	await syncGroup('ann:', notes);

	// Cards the owner made or imported (AI-generated cards are never evidence).
	const cards = new Map<string, Expected>();
	const noteRows = main
		.prepare(`SELECT id, note_type_id, fields, origin, updated_at FROM note WHERE deleted_at IS NULL AND origin != 'ai'`)
		.all() as { id: string; note_type_id: string; fields: string; origin: string; updated_at: number }[];
	const existingCards = new Map(
		(db.prepare(`SELECT key, hash FROM chunk WHERE kind = 'card'`).all() as { key: string; hash: string }[]).map((r) => [r.key, r.hash])
	);
	for (const n of noteRows) {
		const key = `card:${n.id}`;
		const hash = String(n.updated_at);
		// Unchanged cards keep their chunk without re-reading their fields.
		const text = existingCards.get(key) === hash ? '' : noteText(kindForNoteType(n.note_type_id), JSON.parse(n.fields)).slice(0, 3000);
		if (existingCards.get(key) !== hash && text.length < 3) continue;
		cards.set(key, {
			key,
			kind: 'card',
			provenance: n.origin === 'anki' ? 'anki' : 'owner',
			docId: null,
			versionId: null,
			page: null,
			textStart: null,
			textEnd: null,
			rects: null,
			refId: n.id,
			section: null,
			text,
			hash
		});
	}
	await syncGroup('card:', cards);
}

async function embedPending() {
	const db = indexDb();
	const pending = (db.prepare('SELECT count(*) AS n FROM chunk WHERE embedded = 0').get() as { n: number }).n;
	if (!pending) return;
	indexerState.total = pending;
	indexerState.done = 0;
	const select = db.prepare('SELECT id, text FROM chunk WHERE embedded = 0 ORDER BY id LIMIT 16');
	const delVec = db.prepare('DELETE FROM chunk_vec WHERE rowid = ?');
	const insVec = db.prepare('INSERT INTO chunk_vec (rowid, embedding) VALUES (?, ?)');
	const mark = db.prepare('UPDATE chunk SET embedded = 1 WHERE id = ?');
	while (!stopped) {
		const rows = select.all() as { id: number; text: string }[];
		if (!rows.length) break;
		indexerState.message =
			embedStatus().download !== null ? `Downloading the search model (${Math.round((embedStatus().download ?? 0) * 100)}%)` : 'Building meaning search';
		const vectors = await embedPassages(rows.map((r) => r.text));
		// The rows may have been replaced while the model was busy.
		const still = new Set(
			(db.prepare(`SELECT id FROM chunk WHERE id IN (${rows.map(() => '?').join(',')}) AND embedded = 0`).pluck().all(...rows.map((r) => r.id)) as number[])
		);
		db.transaction(() => {
			rows.forEach((r, i) => {
				if (!still.has(r.id)) return;
				delVec.run(BigInt(r.id));
				insVec.run(BigInt(r.id), vectorBuffer(vectors[i]));
				mark.run(r.id);
			});
		})();
		indexerState.done += rows.length;
		await yieldToServer();
	}
}

export function indexSummary() {
	const s = indexStats();
	return {
		...s,
		vectors: vectorsAvailable(),
		embeddings: config.embeddings,
		state: { ...indexerState },
		model: embedStatus()
	};
}
