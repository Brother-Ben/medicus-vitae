import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import { normalizeQuote } from '../pdf/pagetext.js';
import { db, sqlite } from './db';
import { anchor, annotation, annotationRevision, document, documentVersion, highlight, tombstone } from './db/schema';
import { storedFileExists } from './files';
import { uuidv7 } from './ids';
import { sectionAt } from './library';
import { indexEntry, unindexEntry } from './search';

export class ReadingError extends Error {}

export const HIGHLIGHT_COLORS = ['yellow', 'teal', 'pink', 'blue'] as const;
export type HighlightColor = (typeof HIGHLIGHT_COLORS)[number];

export interface AnchorInput {
	documentId: string;
	versionId: string;
	page: number;
	kind: 'text' | 'region';
	rects: number[][];
	textStart?: number | null;
	textEnd?: number | null;
	exact?: string;
	prefix?: string;
	suffix?: string;
}

function validRects(rects: unknown): number[][] | null {
	if (!Array.isArray(rects) || rects.length === 0 || rects.length > 300) return null;
	const out: number[][] = [];
	for (const r of rects) {
		if (!Array.isArray(r) || r.length !== 4) return null;
		const [x0, y0, x1, y1] = r.map(Number);
		if (![x0, y0, x1, y1].every((v) => Number.isFinite(v) && v >= -0.01 && v <= 1.01)) return null;
		if (x1 <= x0 || y1 <= y0) continue;
		out.push([x0, y0, x1, y1].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000));
	}
	return out.length ? out : null;
}

export function createAnchor(input: AnchorInput): string {
	const version = db()
		.select()
		.from(documentVersion)
		.where(and(eq(documentVersion.id, input.versionId), eq(documentVersion.documentId, input.documentId)))
		.get();
	if (!version) throw new ReadingError('That book version was not found.');
	const page = Math.floor(Number(input.page));
	if (!Number.isFinite(page) || page < 1 || (version.pageCount && page > version.pageCount)) {
		throw new ReadingError('Page out of range.');
	}
	const rects = validRects(input.rects);
	if (!rects) throw new ReadingError('The selection has no area.');
	const kind = input.kind === 'region' ? 'region' : 'text';
	const exact = normalizeQuote(String(input.exact ?? '')).slice(0, 10_000);
	if (kind === 'text' && !exact) throw new ReadingError('Select some text first.');
	const id = uuidv7();
	db()
		.insert(anchor)
		.values({
			id,
			documentId: input.documentId,
			versionId: input.versionId,
			pageNumber: page,
			kind,
			rects,
			textStart: Number.isInteger(input.textStart) ? input.textStart : null,
			textEnd: Number.isInteger(input.textEnd) ? input.textEnd : null,
			exact,
			prefix: normalizeQuote(String(input.prefix ?? '')).slice(-64),
			suffix: normalizeQuote(String(input.suffix ?? '')).slice(0, 64),
			sectionTitle: sectionAt(input.documentId, page)?.title ?? null,
			createdAt: Date.now()
		})
		.run();
	return id;
}

export interface AnchorView {
	id: string;
	documentId: string;
	versionId: string;
	page: number;
	kind: string;
	rects: number[][];
	exact: string;
	sectionTitle: string | null;
	documentTitle: string | null;
	/** False when the book or its file is gone; the copied text stays readable. */
	available: boolean;
}

export function anchorViews(ids: string[]): Map<string, AnchorView> {
	const out = new Map<string, AnchorView>();
	const unique = [...new Set(ids.filter(Boolean))];
	if (!unique.length) return out;
	const rows = db().select().from(anchor).where(inArray(anchor.id, unique)).all();
	const docIds = [...new Set(rows.map((r) => r.documentId))];
	const docs = docIds.length ? db().select().from(document).where(inArray(document.id, docIds)).all() : [];
	const docMap = new Map(docs.map((d) => [d.id, d]));
	for (const r of rows) {
		const d = docMap.get(r.documentId);
		out.set(r.id, {
			id: r.id,
			documentId: r.documentId,
			versionId: r.versionId,
			page: r.pageNumber,
			kind: r.kind,
			rects: r.rects,
			exact: r.exact,
			sectionTitle: r.sectionTitle,
			documentTitle: d?.title ?? null,
			available: !!d && d.status !== 'failed' && storedFileExists(d.fileHash)
		});
	}
	return out;
}

export function anchorView(id: string | null | undefined): AnchorView | null {
	if (!id) return null;
	return anchorViews([id]).get(id) ?? null;
}

/** "Biology 2e · 6.5 Enzymes · p. 214" */
export function anchorLabel(a: AnchorView | null): string {
	if (!a) return '';
	const parts = [a.documentTitle ?? 'Missing book'];
	if (a.sectionTitle) parts.push(a.sectionTitle);
	parts.push(`p. ${a.page}`);
	return parts.join(' · ');
}

// ----------------------------------------------------------- highlights

export function createHighlight(anchorId: string, color: string) {
	const a = db().select().from(anchor).where(eq(anchor.id, anchorId)).get();
	if (!a) throw new ReadingError('Anchor not found.');
	const c = (HIGHLIGHT_COLORS as readonly string[]).includes(color) ? color : 'yellow';
	const now = Date.now();
	const id = uuidv7();
	db()
		.insert(highlight)
		.values({ id, anchorId, documentId: a.documentId, color: c, createdAt: now, updatedAt: now })
		.run();
	return id;
}

export function recolorHighlight(id: string, color: string) {
	if (!(HIGHLIGHT_COLORS as readonly string[]).includes(color)) throw new ReadingError('Unknown color.');
	db().update(highlight).set({ color, updatedAt: Date.now() }).where(eq(highlight.id, id)).run();
}

export function deleteHighlight(id: string) {
	const now = Date.now();
	db().transaction((tx) => {
		tx.update(highlight).set({ deletedAt: now, updatedAt: now }).where(eq(highlight.id, id)).run();
		tx.insert(tombstone).values({ id: uuidv7(), recordType: 'highlight', recordId: id, deletedAt: now }).run();
	});
}

// ---------------------------------------------------------- annotations

function annotationSearchBody(body: string, quote: string) {
	return quote ? `${body}\n\n${quote}` : body;
}

export function createAnnotation(input: { anchorId?: string | null; documentId?: string | null; body: string }) {
	const body = input.body.trim();
	if (!body) throw new ReadingError('Write something first.');
	if (body.length > 50_000) throw new ReadingError('That note is too long.');
	let documentId = input.documentId ?? null;
	let quote = '';
	let page: number | null = null;
	if (input.anchorId) {
		const a = db().select().from(anchor).where(eq(anchor.id, input.anchorId)).get();
		if (!a) throw new ReadingError('Anchor not found.');
		documentId = a.documentId;
		quote = a.exact;
		page = a.pageNumber;
	}
	const now = Date.now();
	const id = uuidv7();
	const conn = sqlite();
	db().transaction((tx) => {
		tx.insert(annotation)
			.values({ id, anchorId: input.anchorId ?? null, documentId, body, rev: 1, createdAt: now, updatedAt: now })
			.run();
		tx.insert(annotationRevision).values({ id: uuidv7(), annotationId: id, rev: 1, body, createdAt: now }).run();
		indexEntry(conn, { kind: 'annotation', refId: id, body: annotationSearchBody(body, quote), docId: documentId, page });
	});
	return id;
}

export function updateAnnotation(id: string, body: string) {
	const current = db().select().from(annotation).where(eq(annotation.id, id)).get();
	if (!current || current.deletedAt) throw new ReadingError('Note not found.');
	const clean = body.trim();
	if (!clean) throw new ReadingError('A note cannot be empty. Delete it instead.');
	if (clean === current.body) return;
	const a = current.anchorId ? db().select().from(anchor).where(eq(anchor.id, current.anchorId)).get() : undefined;
	const now = Date.now();
	const rev = current.rev + 1;
	const conn = sqlite();
	db().transaction((tx) => {
		tx.update(annotation).set({ body: clean, rev, updatedAt: now }).where(eq(annotation.id, id)).run();
		tx.insert(annotationRevision).values({ id: uuidv7(), annotationId: id, rev, body: clean, createdAt: now }).run();
		indexEntry(conn, {
			kind: 'annotation',
			refId: id,
			body: annotationSearchBody(clean, a?.exact ?? ''),
			docId: current.documentId,
			page: a?.pageNumber ?? null
		});
	});
}

export function deleteAnnotation(id: string) {
	const now = Date.now();
	const conn = sqlite();
	db().transaction((tx) => {
		tx.update(annotation).set({ deletedAt: now, updatedAt: now }).where(eq(annotation.id, id)).run();
		tx.insert(tombstone).values({ id: uuidv7(), recordType: 'annotation', recordId: id, deletedAt: now }).run();
		unindexEntry(conn, 'annotation', id);
	});
}

export function annotationHistory(id: string) {
	return db()
		.select()
		.from(annotationRevision)
		.where(eq(annotationRevision.annotationId, id))
		.orderBy(desc(annotationRevision.rev))
		.all();
}

/** Highlights and notes on one book, for the reader. */
export function documentMarks(documentId: string) {
	const hl = db()
		.select({ h: highlight, a: anchor })
		.from(highlight)
		.innerJoin(anchor, eq(anchor.id, highlight.anchorId))
		.where(and(eq(highlight.documentId, documentId), isNull(highlight.deletedAt)))
		.all();
	const notes = db()
		.select()
		.from(annotation)
		.where(and(eq(annotation.documentId, documentId), isNull(annotation.deletedAt)))
		.orderBy(asc(annotation.createdAt))
		.all();
	const noteAnchors = anchorViews(notes.map((n) => n.anchorId ?? '').filter(Boolean));
	return {
		highlights: hl.map(({ h, a }) => ({
			id: h.id,
			color: h.color,
			anchorId: a.id,
			page: a.pageNumber,
			kind: a.kind,
			rects: a.rects,
			exact: a.exact,
			createdAt: h.createdAt
		})),
		annotations: notes.map((n) => {
			const a = n.anchorId ? noteAnchors.get(n.anchorId) : undefined;
			return {
				id: n.id,
				body: n.body,
				rev: n.rev,
				anchorId: n.anchorId,
				page: a?.page ?? null,
				rects: a?.rects ?? null,
				exact: a?.exact ?? '',
				createdAt: n.createdAt,
				updatedAt: n.updatedAt
			};
		})
	};
}

/** All reading notes, newest first (the Notes page). */
export function allAnnotations() {
	const rows = db()
		.select()
		.from(annotation)
		.where(isNull(annotation.deletedAt))
		.orderBy(desc(annotation.updatedAt))
		.all();
	const anchors = anchorViews(rows.map((r) => r.anchorId ?? '').filter(Boolean));
	const docIds = [...new Set(rows.map((r) => r.documentId).filter((x): x is string => !!x))];
	const docs = docIds.length ? db().select().from(document).where(inArray(document.id, docIds)).all() : [];
	const titles = new Map(docs.map((d) => [d.id, d.title]));
	return rows.map((r) => {
		const a = r.anchorId ? (anchors.get(r.anchorId) ?? null) : null;
		return {
			id: r.id,
			body: r.body,
			rev: r.rev,
			documentId: r.documentId,
			documentTitle: r.documentId ? (titles.get(r.documentId) ?? 'Missing book') : null,
			anchor: a,
			label: anchorLabel(a),
			updatedAt: r.updatedAt
		};
	});
}
