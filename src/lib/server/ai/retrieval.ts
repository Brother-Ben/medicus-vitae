import { sqlite } from '../db';
import { embedQuery, vectorBuffer } from './embed';
import { indexDb, vectorsAvailable, type ChunkRow } from './index-db';

// Finds the passages most relevant to a question (AI-08, spec 12.4 step 1):
// keyword matches (FTS5) and meaning matches (local embeddings) combined by
// reciprocal-rank fusion, with a nudge toward what the owner is looking at.
// AI-generated text is never returned.

export interface Passage {
	chunkId: number;
	kind: ChunkRow['kind'];
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
	label: string;
	score: number;
}

const STOP = new Set(
	'a an and are as at be but by can do does for from has have how i if in into is it its may me my not of on or so than that the their them then there these they this to was what when where which who why will with would you your about explain tell describe define give list compare difference between mean means meaning'.split(
		' '
	)
);

/** A forgiving keyword query: any of the meaningful words, best matches first. */
export function looseFtsQuery(input: string): string | null {
	const words = [...new Set((input.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length > 1 && !STOP.has(w)))].slice(0, 24);
	if (!words.length) return null;
	return words.map((w) => `"${w}"`).join(' OR ');
}

function docTitles(ids: string[]) {
	const unique = [...new Set(ids.filter(Boolean))];
	if (!unique.length) return new Map<string, string>();
	const rows = sqlite()
		.prepare(`SELECT id, title FROM document WHERE id IN (${unique.map(() => '?').join(',')})`)
		.all(...unique) as { id: string; title: string }[];
	return new Map(rows.map((r) => [r.id, r.title]));
}

export function passageLabel(c: Pick<ChunkRow, 'kind' | 'page' | 'section' | 'provenance'>, title: string | null) {
	if (c.kind === 'card') return c.provenance === 'anki' ? 'Card from Anki' : 'Your card';
	if (c.kind === 'annotation') return [`Your note`, title, c.page ? `p. ${c.page}` : null].filter(Boolean).join(' · ');
	const parts = [title ?? 'Book'];
	if (c.section) parts.push(c.section);
	if (c.page) parts.push(`p. ${c.page}`);
	if (c.kind === 'figure') parts.push('figure');
	return parts.join(' · ');
}

function toPassages(rows: (ChunkRow & { score: number })[]): Passage[] {
	const titles = docTitles(rows.map((r) => r.doc_id ?? ''));
	return rows.map((r) => ({
		chunkId: r.id,
		kind: r.kind,
		provenance: r.provenance,
		docId: r.doc_id,
		versionId: r.version_id,
		page: r.page,
		textStart: r.text_start,
		textEnd: r.text_end,
		rects: r.rects ? (JSON.parse(r.rects) as number[][]) : null,
		refId: r.ref_id,
		section: r.section,
		text: r.text,
		label: passageLabel(r, r.doc_id ? (titles.get(r.doc_id) ?? null) : null),
		score: r.score
	}));
}

function chunksById(ids: number[]): Map<number, ChunkRow> {
	if (!ids.length) return new Map();
	const rows = indexDb()
		.prepare(`SELECT * FROM chunk WHERE id IN (${ids.map(() => '?').join(',')}) AND provenance != 'ai'`)
		.all(...ids) as ChunkRow[];
	return new Map(rows.map((r) => [r.id, r]));
}

export interface RetrieveOptions {
	k?: number;
	documentId?: string | null;
	page?: number | null;
	kinds?: ChunkRow['kind'][];
	/** Keyword-only (when the embedding model isn't wanted, e.g. in tests). */
	keywordOnly?: boolean;
}

export function keywordCandidates(query: string, limit = 40): { id: number; rank: number }[] {
	const fts = looseFtsQuery(query);
	if (!fts) return [];
	try {
		return (
			indexDb()
				.prepare(`SELECT rowid AS id FROM chunk_fts WHERE chunk_fts MATCH ? ORDER BY bm25(chunk_fts) LIMIT ?`)
				.all(fts, limit) as { id: number }[]
		).map((r, i) => ({ id: r.id, rank: i }));
	} catch {
		return [];
	}
}

export async function meaningCandidates(query: string, limit = 40): Promise<{ id: number; rank: number; distance: number }[]> {
	if (!vectorsAvailable()) return [];
	const db = indexDb();
	const embedded = (db.prepare('SELECT count(*) AS n FROM chunk WHERE embedded = 1').get() as { n: number }).n;
	if (!embedded) return [];
	let v: Float32Array;
	try {
		v = await embedQuery(query);
	} catch {
		return [];
	}
	const rows = db
		.prepare('SELECT rowid AS id, distance FROM chunk_vec WHERE embedding MATCH ? AND k = ?')
		.all(vectorBuffer(v), limit) as { id: number; distance: number }[];
	return rows.map((r, i) => ({ id: Number(r.id), rank: i, distance: r.distance }));
}

export async function retrieve(query: string, opts: RetrieveOptions = {}): Promise<Passage[]> {
	const k = opts.k ?? 8;
	const [kw, mn] = await Promise.all([Promise.resolve(keywordCandidates(query)), opts.keywordOnly ? [] : meaningCandidates(query)]);
	const scores = new Map<number, number>();
	const add = (id: number, rank: number) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + rank));
	for (const c of kw) add(c.id, c.rank);
	// Very distant "meaning" matches are noise; keep only reasonably close ones.
	for (const c of mn) if (c.distance < 0.6) add(c.id, c.rank);
	const chunks = chunksById([...scores.keys()]);
	const scored: (ChunkRow & { score: number })[] = [];
	for (const [id, s] of scores) {
		const c = chunks.get(id);
		if (!c) continue;
		if (opts.kinds && !opts.kinds.includes(c.kind)) continue;
		let score = s;
		if (opts.documentId && c.doc_id === opts.documentId) {
			score += 0.004;
			if (opts.page && c.page && Math.abs(c.page - opts.page) <= 1) score += 0.006;
		}
		scored.push({ ...c, score });
	}
	scored.sort((a, b) => b.score - a.score);
	// Drop passages that overlap one already chosen on the same page.
	const chosen: (ChunkRow & { score: number })[] = [];
	for (const c of scored) {
		const overlaps = chosen.some(
			(x) =>
				x.version_id &&
				x.version_id === c.version_id &&
				x.page === c.page &&
				x.kind === c.kind &&
				x.text_start !== null &&
				c.text_start !== null &&
				x.text_end !== null &&
				c.text_end !== null &&
				x.text_start < c.text_end &&
				c.text_start < x.text_end
		);
		if (!overlaps) chosen.push(c);
		if (chosen.length >= k) break;
	}
	return toPassages(chosen);
}

/** Meaning search for the Search page: closest passages, with keyword results as a fallback. */
export async function meaningSearch(query: string, limit = 20): Promise<{ passages: Passage[]; usedMeaning: boolean }> {
	const mn = await meaningCandidates(query, limit);
	if (mn.length) {
		const chunks = chunksById(mn.map((m) => m.id));
		const rows = mn
			.filter((m) => m.distance < 0.75)
			.map((m) => {
				const c = chunks.get(m.id);
				return c ? { ...c, score: 1 - m.distance } : null;
			})
			.filter((x): x is ChunkRow & { score: number } => !!x);
		return { passages: toPassages(rows), usedMeaning: true };
	}
	return { passages: await retrieve(query, { k: limit, keywordOnly: true }), usedMeaning: false };
}
