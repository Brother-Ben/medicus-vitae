import fs from 'node:fs';
import { and, asc, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';
import { isCategoryCode } from '../aamc';
import { bookProgress, type BookProgress } from '../ranges';
import { db, sqlite } from './db';
import { docPage, docSection, document, documentVersion, job } from './db/schema';
import { defaultTitleFromFileName } from './extract';
import { commitTmpFile, isPdfHeader, storedFileExists, type ReceivedFile } from './files';
import { uuidv7 } from './ids';
import { kickJobs } from './jobs';

export class LibraryError extends Error {}

/**
 * Deletes documents (books or notes PDFs) and what hangs off them: pages,
 * chapters, highlights, links from notes, search entries. Anchors that cards,
 * notes or questions still point at are kept (they hold a copy of the text).
 * The PDF files stay in the file store, where snapshots can still find them.
 */
export function deleteDocumentRecords(docIds: string[]) {
	if (!docIds.length) return;
	const run = (q: string, ...p: unknown[]) => sqlite().prepare(q).run(...p);
	const list = docIds.map(() => '?').join(',');
	run(`DELETE FROM note_link WHERE notes_document_id IN (${list}) OR book_document_id IN (${list})`, ...docIds, ...docIds);
	// Decks linked to the book keep their cards as they are; only the link goes.
	run(`DELETE FROM deck_book_map WHERE link_id IN (SELECT id FROM deck_book_link WHERE document_id IN (${list}))`, ...docIds);
	run(`DELETE FROM deck_book_link WHERE document_id IN (${list})`, ...docIds);
	run(`DELETE FROM highlight WHERE document_id IN (${list})`, ...docIds);
	run(`DELETE FROM doc_page WHERE version_id IN (SELECT id FROM document_version WHERE document_id IN (${list}))`, ...docIds);
	run(`DELETE FROM document_version WHERE document_id IN (${list})`, ...docIds);
	run(`DELETE FROM doc_section WHERE document_id IN (${list})`, ...docIds);
	run(`DELETE FROM search_index WHERE kind = 'page' AND doc_id IN (${list})`, ...docIds);
	run(`DELETE FROM job WHERE json_extract(payload, '$.documentId') IN (${list})`, ...docIds);
	run(`DELETE FROM document WHERE id IN (${list})`, ...docIds);
	run(
		`DELETE FROM anchor WHERE document_id IN (${list})
		 AND id NOT IN (SELECT anchor_id FROM highlight WHERE anchor_id IS NOT NULL)
		 AND id NOT IN (SELECT anchor_id FROM annotation WHERE anchor_id IS NOT NULL)
		 AND id NOT IN (SELECT anchor_id FROM note WHERE anchor_id IS NOT NULL)
		 AND id NOT IN (SELECT anchor_id FROM question WHERE anchor_id IS NOT NULL)`,
		...docIds
	);
}

export function createDocumentFromUpload(received: ReceivedFile, fileName: string, role: 'book' | 'notes' = 'book') {
	if (!isPdfHeader(received.head)) {
		fs.rmSync(received.tmpPath, { force: true });
		throw new LibraryError('That file is not a PDF. This version imports text-based PDFs.');
	}
	if (received.size === 0) {
		fs.rmSync(received.tmpPath, { force: true });
		throw new LibraryError('That file is empty.');
	}
	const existing = db().select().from(document).where(eq(document.fileHash, received.hash)).get();
	if (existing) {
		fs.rmSync(received.tmpPath, { force: true });
		return { id: existing.id, duplicate: true };
	}

	const now = Date.now();
	const id = uuidv7();
	const versionId = uuidv7();
	const safeName = fileName.replace(/[\\/]/g, '_').slice(0, 200) || (role === 'notes' ? 'notes.pdf' : 'book.pdf');
	db().transaction((tx) => {
		tx.insert(document)
			.values({
				id,
				title: defaultTitleFromFileName(safeName),
				kind: 'pdf',
				role,
				fileHash: received.hash,
				fileName: safeName,
				fileSize: received.size,
				status: 'queued',
				provenance: 'original',
				createdAt: now,
				updatedAt: now
			})
			.run();
		tx.insert(documentVersion)
			.values({ id: versionId, documentId: id, extractionVersion: 'pending', status: 'processing', createdAt: now })
			.run();
		tx.insert(job)
			.values({
				id: uuidv7(),
				type: 'extract_pdf',
				payload: { documentId: id, versionId, tmpPath: received.tmpPath },
				status: 'queued',
				createdAt: now,
				updatedAt: now
			})
			.run();
	});
	// Records first, then the file: if we stop in between, the queued job finishes the move.
	commitTmpFile(received.tmpPath, received.hash);
	kickJobs();
	return { id, duplicate: false };
}

export function retryDocument(id: string) {
	const doc = getDocument(id);
	if (!doc) throw new LibraryError('Book not found.');
	const now = Date.now();
	const versionId = uuidv7();
	db().transaction((tx) => {
		tx.insert(documentVersion)
			.values({ id: versionId, documentId: id, extractionVersion: 'pending', status: 'processing', createdAt: now })
			.run();
		tx.insert(job)
			.values({
				id: uuidv7(),
				type: 'extract_pdf',
				payload: { documentId: id, versionId },
				status: 'queued',
				createdAt: now,
				updatedAt: now
			})
			.run();
		tx.update(document).set({ status: 'queued', error: null, updatedAt: now }).where(eq(document.id, id)).run();
	});
	kickJobs();
}

export function getDocument(id: string) {
	return db().select().from(document).where(eq(document.id, id)).get();
}

export function renameDocument(id: string, title: string) {
	const clean = title.replace(/\s+/g, ' ').trim().slice(0, 200);
	if (!clean) throw new LibraryError('Give the book a title.');
	db().update(document).set({ title: clean, updatedAt: Date.now() }).where(eq(document.id, id)).run();
}

export interface LibraryItem {
	id: string;
	title: string;
	status: string;
	error: string | null;
	notice: string | null;
	pageCount: number | null;
	fileSize: number;
	furthestPage: number | null;
	lastPage: number | null;
	lastOpenedAt: number | null;
	createdAt: number;
	highlights: number;
	annotations: number;
	cards: number;
	progress: number | null;
	progressMessage: string;
	fileMissing: boolean;
	/** What the owner has marked done (chapters, or "read up to page N"). */
	done: BookProgress;
	/** Anki decks linked to this book. */
	linkedDecks: string[];
}

/** Books (the Library), or the notes PDFs shown under Notes. */
export function listDocuments(role: 'book' | 'notes' = 'book'): LibraryItem[] {
	const docs = db().select().from(document).where(eq(document.role, role)).orderBy(desc(document.createdAt)).all();
	const counts = (table: string, extra = '') =>
		new Map(
			(
				sqlite()
					.prepare(
						`SELECT document_id AS id, count(*) AS n FROM ${table} WHERE deleted_at IS NULL ${extra} GROUP BY document_id`
					)
					.all() as { id: string; n: number }[]
			).map((r) => [r.id, r.n])
		);
	const highlightCounts = counts('highlight');
	const annotationCounts = counts('annotation');
	const cardCounts = new Map(
		(
			sqlite()
				.prepare(
					`SELECT a.document_id AS id, count(c.id) AS n FROM card c
					 JOIN note n ON n.id = c.note_id JOIN anchor a ON a.id = n.anchor_id
					 WHERE c.deleted_at IS NULL AND n.deleted_at IS NULL GROUP BY a.document_id`
				)
				.all() as { id: string; n: number }[]
		).map((r) => [r.id, r.n])
	);
	const jobs = db()
		.select()
		.from(job)
		.where(and(eq(job.type, 'extract_pdf')))
		.all()
		.filter((j) => j.status === 'queued' || j.status === 'running');
	const sectionsByDoc = new Map<string, { id: string; title: string; level: number; pageStart: number; pageEnd: number }[]>();
	for (const s of sqlite().prepare('SELECT id, document_id, title, level, page_start, page_end FROM doc_section ORDER BY position').all() as {
		id: string;
		document_id: string;
		title: string;
		level: number;
		page_start: number;
		page_end: number;
	}[]) {
		const list = sectionsByDoc.get(s.document_id) ?? sectionsByDoc.set(s.document_id, []).get(s.document_id)!;
		list.push({ id: s.id, title: s.title, level: s.level, pageStart: s.page_start, pageEnd: s.page_end });
	}
	const links = new Map<string, string[]>();
	for (const l of sqlite().prepare('SELECT document_id, deck FROM deck_book_link WHERE deleted_at IS NULL ORDER BY created_at').all() as { document_id: string; deck: string }[]) {
		(links.get(l.document_id) ?? links.set(l.document_id, []).get(l.document_id)!).push(l.deck);
	}
	return docs.map((d) => {
		const j = jobs.find((x) => x.payload.documentId === d.id);
		return {
			id: d.id,
			title: d.title,
			status: d.status,
			error: d.error,
			notice: d.notice,
			pageCount: d.pageCount,
			fileSize: d.fileSize,
			furthestPage: d.furthestPage,
			lastPage: d.lastPage,
			lastOpenedAt: d.lastOpenedAt,
			createdAt: d.createdAt,
			highlights: highlightCounts.get(d.id) ?? 0,
			annotations: annotationCounts.get(d.id) ?? 0,
			cards: cardCounts.get(d.id) ?? 0,
			progress: j ? j.progress : null,
			progressMessage: j ? j.message || (j.status === 'queued' ? 'Waiting to start' : 'Working') : '',
			fileMissing: !storedFileExists(d.fileHash),
			done: bookProgress(d.readRanges ?? [], d.pageCount, sectionsByDoc.get(d.id) ?? []),
			linkedDecks: links.get(d.id) ?? []
		};
	});
}

export function documentSections(documentId: string) {
	return db()
		.select()
		.from(docSection)
		.where(eq(docSection.documentId, documentId))
		.orderBy(asc(docSection.position))
		.all();
}

/** The most specific section containing a page (sub-section before chapter). */
export function sectionAt(documentId: string, page: number) {
	const rows = db()
		.select()
		.from(docSection)
		.where(and(eq(docSection.documentId, documentId), lte(docSection.pageStart, page), gte(docSection.pageEnd, page)))
		.all();
	return rows.sort((a, b) => b.level - a.level || b.pageStart - a.pageStart)[0];
}

/** AAMC category a card made on this page should start with. */
export function defaultCategoryFor(documentId: string, page: number): string | null {
	const rows = db()
		.select()
		.from(docSection)
		.where(and(eq(docSection.documentId, documentId), lte(docSection.pageStart, page), gte(docSection.pageEnd, page)))
		.all()
		.sort((a, b) => b.level - a.level);
	for (const s of rows) {
		if (s.aamcCodes.length) return s.aamcCodes[0];
	}
	return null;
}

export function setSectionCodes(sectionId: string, codes: string[]) {
	const clean = [...new Set(codes.filter(isCategoryCode))].slice(0, 4);
	db().update(docSection).set({ aamcCodes: clean, confirmed: true }).where(eq(docSection.id, sectionId)).run();
}

export function acceptAllSuggestions(documentId: string) {
	for (const s of documentSections(documentId)) {
		if (s.confirmed) continue;
		setSectionCodes(
			s.id,
			s.suggestedCodes.map((c) => c.code)
		);
	}
}

export function updateReadingPosition(documentId: string, page: number) {
	const doc = getDocument(documentId);
	if (!doc) return;
	const p = Math.max(1, Math.min(page, doc.pageCount ?? page));
	db()
		.update(document)
		.set({
			lastPage: p,
			furthestPage: Math.max(doc.furthestPage ?? 0, p),
			lastOpenedAt: Date.now()
		})
		.where(eq(document.id, documentId))
		.run();
}

export function pageText(versionId: string, page: number) {
	return db()
		.select()
		.from(docPage)
		.where(and(eq(docPage.versionId, versionId), eq(docPage.pageNumber, page)))
		.get();
}

export function pageSizes(versionId: string) {
	return db()
		.select({ page: docPage.pageNumber, width: docPage.width, height: docPage.height })
		.from(docPage)
		.where(eq(docPage.versionId, versionId))
		.orderBy(asc(docPage.pageNumber))
		.all();
}

export function continueReading() {
	return db()
		.select()
		.from(document)
		.where(and(eq(document.status, 'ready'), eq(document.role, 'book'), sql`${document.lastOpenedAt} IS NOT NULL`))
		.orderBy(desc(document.lastOpenedAt))
		.limit(1)
		.get();
}

export function readyDocumentCount() {
	return db().select({ n: sql<number>`count(*)` }).from(document).where(isNull(document.error)).get()?.n ?? 0;
}
