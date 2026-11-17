import type Database from 'better-sqlite3';
import { sqlite } from './db';

// Keyword search over book pages, annotations and cards (LIB-03). Works with no
// AI connection. The index is derived data: it can be rebuilt from the tables.

export type SearchKind = 'page' | 'annotation' | 'card';

export function indexEntry(
	conn: Database.Database,
	entry: { kind: SearchKind; refId: string; body: string; docId?: string | null; page?: number | null }
) {
	conn.prepare('DELETE FROM search_index WHERE kind = ? AND ref_id = ?').run(entry.kind, entry.refId);
	if (!entry.body.trim()) return;
	conn
		.prepare('INSERT INTO search_index (body, kind, ref_id, doc_id, page) VALUES (?, ?, ?, ?, ?)')
		.run(entry.body, entry.kind, entry.refId, entry.docId ?? null, entry.page ?? null);
}

export function unindexEntry(conn: Database.Database, kind: SearchKind, refId: string) {
	conn.prepare('DELETE FROM search_index WHERE kind = ? AND ref_id = ?').run(kind, refId);
}

export function unindexDocumentPages(conn: Database.Database, docId: string) {
	conn.prepare("DELETE FROM search_index WHERE kind = 'page' AND doc_id = ?").run(docId);
}

/**
 * Turns what the owner typed into a safe FTS5 query: words are ANDed, "quoted
 * phrases" stay phrases, and the last word also matches as a prefix.
 */
export function toFtsQuery(input: string): string | null {
	const parts: string[] = [];
	const re = /"([^"]+)"|([\p{L}\p{N}][\p{L}\p{N}'’_-]*)/gu;
	let m: RegExpExecArray | null;
	const raw: { text: string; phrase: boolean }[] = [];
	while ((m = re.exec(input))) {
		if (m[1]) raw.push({ text: m[1], phrase: true });
		else if (m[2]) raw.push({ text: m[2], phrase: false });
	}
	raw.forEach((t, i) => {
		const words = t.text.match(/[\p{L}\p{N}]+/gu);
		if (!words?.length) return;
		const quoted = `"${words.join(' ')}"`;
		const isLast = i === raw.length - 1;
		parts.push(!t.phrase && isLast && words.length === 1 && words[0].length >= 2 ? `${quoted}*` : quoted);
	});
	return parts.length ? parts.join(' ') : null;
}

export interface SearchSegment {
	text: string;
	hit: boolean;
}

export interface SearchHit {
	kind: SearchKind;
	refId: string;
	docId: string | null;
	page: number | null;
	segments: SearchSegment[];
	score: number;
}

const START = '\u0002';
const END = '\u0003';

function toSegments(snippet: string): SearchSegment[] {
	const out: SearchSegment[] = [];
	let rest = snippet.replace(/\s+/g, ' ');
	while (rest.length) {
		const s = rest.indexOf(START);
		if (s === -1) {
			out.push({ text: rest, hit: false });
			break;
		}
		if (s > 0) out.push({ text: rest.slice(0, s), hit: false });
		const e = rest.indexOf(END, s + 1);
		const hit = rest.slice(s + 1, e === -1 ? undefined : e);
		out.push({ text: hit, hit: true });
		rest = e === -1 ? '' : rest.slice(e + 1);
	}
	return out;
}

export function search(
	input: string,
	opts: { kinds?: SearchKind[]; docId?: string; limit?: number; offset?: number } = {}
): { hits: SearchHit[]; total: number; query: string | null } {
	const query = toFtsQuery(input);
	if (!query) return { hits: [], total: 0, query: null };
	const where: string[] = ['search_index MATCH ?'];
	const params: unknown[] = [query];
	if (opts.kinds?.length) {
		where.push(`kind IN (${opts.kinds.map(() => '?').join(',')})`);
		params.push(...opts.kinds);
	}
	if (opts.docId) {
		where.push('doc_id = ?');
		params.push(opts.docId);
	}
	const conn = sqlite();
	try {
		const total = (
			conn.prepare(`SELECT count(*) AS n FROM search_index WHERE ${where.join(' AND ')}`).get(...params) as { n: number }
		).n;
		const rows = conn
			.prepare(
				`SELECT kind, ref_id, doc_id, page, bm25(search_index) AS score,
				        snippet(search_index, 0, '${START}', '${END}', '…', 18) AS snip
				 FROM search_index WHERE ${where.join(' AND ')}
				 ORDER BY score LIMIT ? OFFSET ?`
			)
			.all(...params, opts.limit ?? 30, opts.offset ?? 0) as {
			kind: SearchKind;
			ref_id: string;
			doc_id: string | null;
			page: number | null;
			score: number;
			snip: string;
		}[];
		return {
			total,
			query,
			hits: rows.map((r) => ({
				kind: r.kind,
				refId: r.ref_id,
				docId: r.doc_id,
				page: r.page === null ? null : Number(r.page),
				score: r.score,
				segments: toSegments(r.snip)
			}))
		};
	} catch {
		// A query FTS5 can't parse just finds nothing.
		return { hits: [], total: 0, query };
	}
}

/** Pages of one book matching the query, in page order (for "search within book"). */
export function searchWithinDocument(input: string, docId: string, limit = 200) {
	const query = toFtsQuery(input);
	if (!query) return [];
	try {
		const rows = sqlite()
			.prepare(
				`SELECT page, snippet(search_index, 0, '${START}', '${END}', '…', 14) AS snip
				 FROM search_index WHERE search_index MATCH ? AND kind = 'page' AND doc_id = ?
				 ORDER BY CAST(page AS INTEGER) LIMIT ?`
			)
			.all(query, docId, limit) as { page: number; snip: string }[];
		return rows.map((r) => ({ page: Number(r.page), segments: toSegments(r.snip) }));
	} catch {
		return [];
	}
}
