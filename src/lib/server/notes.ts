import { and, asc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import { CATEGORY_SHORT } from '../aamc';
import { db, inTx } from './db';
import { document, noteLink } from './db/schema';
import { uuidv7 } from './ids';
import { deleteDocumentRecords, documentSections, getDocument, listDocuments, sectionAt } from './library';
import { allAnnotations } from './reading';

// The Notes page: written reading notes (annotations) and PDFs of the owner's
// own notes, each linked to the book pages it covers. Links show up in the
// reader on those pages ("Your notes for this page").

export class NotesError extends Error {}

export interface NoteLinkView {
	id: string;
	notesDocumentId: string;
	notesTitle: string;
	notesPageFrom: number | null;
	notesPageTo: number | null;
	bookDocumentId: string;
	bookTitle: string;
	bookPageFrom: number;
	bookPageTo: number;
	/** The chapter the book pages start in. */
	section: string | null;
	aamcCodes: string[];
	label: string;
}

function linkViews(rows: (typeof noteLink.$inferSelect)[]): NoteLinkView[] {
	const ids = [...new Set(rows.flatMap((r) => [r.notesDocumentId, r.bookDocumentId]))];
	const titles = new Map(ids.length ? db().select({ id: document.id, title: document.title }).from(document).where(inArray(document.id, ids)).all().map((d) => [d.id, d.title]) : []);
	return rows.map((r) => {
		const s = sectionAt(r.bookDocumentId, r.bookPageFrom);
		return {
			id: r.id,
			notesDocumentId: r.notesDocumentId,
			notesTitle: titles.get(r.notesDocumentId) ?? 'Notes',
			notesPageFrom: r.notesPageFrom,
			notesPageTo: r.notesPageTo,
			bookDocumentId: r.bookDocumentId,
			bookTitle: titles.get(r.bookDocumentId) ?? 'Missing book',
			bookPageFrom: r.bookPageFrom,
			bookPageTo: r.bookPageTo,
			section: s?.title ?? null,
			aamcCodes: s?.aamcCodes ?? [],
			label: r.label
		};
	});
}

/** The notes PDFs, with what each is linked to. */
export function notesFiles() {
	const files = listDocuments('notes');
	const links = linkViews(
		files.length
			? db()
					.select()
					.from(noteLink)
					.where(and(isNull(noteLink.deletedAt), inArray(noteLink.notesDocumentId, files.map((f) => f.id))))
					.orderBy(asc(noteLink.bookPageFrom))
					.all()
			: []
	);
	return files.map((f) => ({ ...f, links: links.filter((l) => l.notesDocumentId === f.id) }));
}

/** Notes PDFs linked to a book page (for the reader). */
export function notesForBookPage(bookId: string, page: number): NoteLinkView[] {
	return linkViews(
		db()
			.select()
			.from(noteLink)
			.where(and(isNull(noteLink.deletedAt), eq(noteLink.bookDocumentId, bookId), lte(noteLink.bookPageFrom, page), gte(noteLink.bookPageTo, page)))
			.all()
	);
}

/** Every link into one book (the reader shows the ones for the page you're on). */
export function notesForBook(bookId: string): NoteLinkView[] {
	return linkViews(
		db().select().from(noteLink).where(and(isNull(noteLink.deletedAt), eq(noteLink.bookDocumentId, bookId))).orderBy(asc(noteLink.bookPageFrom)).all()
	);
}

export interface LinkInput {
	notesDocumentId: string;
	notesPageFrom?: number | null;
	notesPageTo?: number | null;
	bookDocumentId: string;
	/** A chapter instead of pages: its pages are used. */
	sectionId?: string | null;
	bookPageFrom?: number | null;
	bookPageTo?: number | null;
	label?: string;
}

function cleanLink(input: LinkInput) {
	const notes = getDocument(input.notesDocumentId);
	if (!notes || notes.role !== 'notes') throw new NotesError('Notes file not found.');
	const book = getDocument(input.bookDocumentId);
	if (!book || book.role !== 'book') throw new NotesError('Pick a book from your library.');
	let from = Math.round(Number(input.bookPageFrom) || 0);
	let to = Math.round(Number(input.bookPageTo) || 0);
	if (input.sectionId) {
		const s = documentSections(book.id).find((x) => x.id === input.sectionId);
		if (!s) throw new NotesError('That chapter isn’t in this book.');
		from = s.pageStart;
		to = s.pageEnd;
	}
	const max = book.pageCount ?? Math.max(from, to, 1);
	if (from < 1) throw new NotesError('Enter the book page these notes start on.');
	from = Math.min(from, max);
	to = Math.max(from, Math.min(to || from, max));
	let nFrom = input.notesPageFrom ? Math.max(1, Math.round(Number(input.notesPageFrom))) : null;
	let nTo = input.notesPageTo ? Math.max(1, Math.round(Number(input.notesPageTo))) : null;
	if (nFrom && notes.pageCount) nFrom = Math.min(nFrom, notes.pageCount);
	if (nFrom && !nTo) nTo = nFrom;
	if (nTo && nFrom && nTo < nFrom) [nFrom, nTo] = [nTo, nFrom];
	if (nTo && notes.pageCount) nTo = Math.min(nTo, notes.pageCount);
	return { notesDocumentId: notes.id, notesPageFrom: nFrom, notesPageTo: nTo, bookDocumentId: book.id, bookPageFrom: from, bookPageTo: to, label: String(input.label ?? '').trim().slice(0, 120) };
}

export function addLink(input: LinkInput) {
	const v = cleanLink(input);
	const now = Date.now();
	const id = uuidv7();
	db()
		.insert(noteLink)
		.values({ id, ...v, createdAt: now, updatedAt: now })
		.run();
	return id;
}

export function updateLink(id: string, input: LinkInput) {
	const v = cleanLink(input);
	db()
		.update(noteLink)
		.set({ ...v, updatedAt: Date.now() })
		.where(eq(noteLink.id, id))
		.run();
}

export function removeLink(id: string) {
	db().update(noteLink).set({ deletedAt: Date.now(), updatedAt: Date.now() }).where(eq(noteLink.id, id)).run();
}

export function deleteNotesFile(id: string) {
	const doc = getDocument(id);
	if (!doc || doc.role !== 'notes') throw new NotesError('Notes file not found.');
	inTx(() => deleteDocumentRecords([id]));
}

/** Written notes with the chapter and AAMC categories of the page they're on, for filtering. */
export function writtenNotes() {
	return allAnnotations().map((n) => {
		const s = n.anchor ? sectionAt(n.anchor.documentId, n.anchor.page) : null;
		return {
			...n,
			page: n.anchor?.page ?? null,
			section: s?.title ?? null,
			sectionId: s?.id ?? null,
			aamcCodes: s?.aamcCodes ?? []
		};
	});
}

/** Books with their chapters, for the filters and the "link to book pages" dialog. */
export function booksForNotes() {
	return listDocuments('book')
		.filter((d) => d.status === 'ready')
		.map((d) => ({
			id: d.id,
			title: d.title,
			pageCount: d.pageCount ?? 1,
			sections: documentSections(d.id).map((s) => ({ id: s.id, title: s.title, level: s.level, pageStart: s.pageStart, pageEnd: s.pageEnd, aamcCodes: s.aamcCodes }))
		}));
}

export function categoryLabel(code: string) {
	return `${code} ${CATEGORY_SHORT[code] ?? ''}`.trim();
}
