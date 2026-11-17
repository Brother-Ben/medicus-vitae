import { eq } from 'drizzle-orm';
import { addRange, bookProgress, mergeRanges, subtractRange, type BookProgress, type PageRange } from '../ranges';
import { db } from './db';
import { docSection, document } from './db/schema';
import { applyLinksForDocument, type ApplySummary } from './deck-links';
import { documentSections, LibraryError } from './library';

// Book progress (what the owner has actually finished): chapters checked off,
// or "I've read up to page N". Opening or jumping to a page never changes it.
// Decks linked to the book follow each change (deck-links.ts).

export interface ProgressResult {
	ranges: PageRange[];
	progress: BookProgress;
	/** What linked decks did: cards unsuspended or suspended, with the batch to undo. */
	cards: ApplySummary | null;
	/** The ranges before this change, for Undo. */
	previous: PageRange[];
}

function load(documentId: string) {
	const d = db().select().from(document).where(eq(document.id, documentId)).get();
	if (!d) throw new LibraryError('Book not found.');
	return d;
}

export function progressFor(documentId: string): BookProgress {
	const d = load(documentId);
	return bookProgress(d.readRanges ?? [], d.pageCount, documentSections(documentId));
}

function save(documentId: string, next: PageRange[], reason: string): ProgressResult {
	const d = load(documentId);
	const previous = mergeRanges(d.readRanges ?? [], d.pageCount);
	const ranges = mergeRanges(next, d.pageCount);
	db().update(document).set({ readRanges: ranges, progressAt: Date.now() }).where(eq(document.id, documentId)).run();
	const cards = applyLinksForDocument(documentId, reason);
	return { ranges, previous, cards, progress: bookProgress(ranges, d.pageCount, documentSections(documentId)) };
}

/** Marks chapters done or not done. */
export function markSections(documentId: string, sectionIds: string[], done: boolean): ProgressResult {
	const d = load(documentId);
	const sections = db().select().from(docSection).where(eq(docSection.documentId, documentId)).all();
	const chosen = sections.filter((s) => sectionIds.includes(s.id));
	if (!chosen.length) throw new LibraryError('Pick a chapter.');
	let ranges = mergeRanges(d.readRanges ?? [], d.pageCount);
	for (const s of chosen) ranges = done ? addRange(ranges, [s.pageStart, s.pageEnd], d.pageCount) : subtractRange(ranges, [s.pageStart, s.pageEnd]);
	const names = chosen.length === 1 ? chosen[0].title : `${chosen.length} chapters`;
	return save(documentId, ranges, done ? `Finished ${names}` : `Marked ${names} not done`);
}

/** "I've read up to page N": pages 1–N done, nothing after. 0 clears the book's progress. */
export function setReadUpTo(documentId: string, page: number): ProgressResult {
	const d = load(documentId);
	const p = Math.max(0, Math.min(Math.floor(Number(page) || 0), d.pageCount ?? Number.MAX_SAFE_INTEGER));
	return save(documentId, p ? [[1, p]] : [], p ? `Read up to page ${p}` : 'Progress reset');
}

/** Puts the progress back to exactly these ranges (Undo). */
export function setRanges(documentId: string, ranges: PageRange[], reason = 'Progress changed'): ProgressResult {
	return save(documentId, ranges, reason);
}
