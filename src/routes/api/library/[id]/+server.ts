import { bookDeletePreview, deleteBook } from '#lib/server/deletion.js';
import { documentSections, getDocument, LibraryError, renameDocument, retryDocument, setSectionCodes, acceptAllSuggestions, updateReadingPosition } from '#lib/server/library.js';
import { completeSessionWork } from '#lib/server/planner.js';
import { markSections, setRanges, setReadUpTo } from '#lib/server/progress.js';
import { documentMarks } from '#lib/server/reading.js';
import { searchWithinDocument } from '#lib/server/search.js';
import { sqlite } from '#lib/server/db/index.js';
import { undoSuspendBatch } from '#lib/server/suspend.js';
import type { PageRange } from '#lib/ranges.js';
import type { RequestHandler } from './$types';

/** Marks (highlights, notes, card anchors), search within the book with ?q=, or what deleting it removes with ?delete. */
export const GET: RequestHandler = ({ params, url }) => {
	const doc = getDocument(params.id);
	if (!doc) return Response.json({ error: 'Book not found.' }, { status: 404 });
	const q = url.searchParams.get('q');
	if (q !== null) return Response.json({ results: searchWithinDocument(q, doc.id) });
	if (url.searchParams.has('delete')) {
		try {
			return Response.json(bookDeletePreview(doc.id));
		} catch (err) {
			return Response.json({ error: err instanceof Error ? err.message : 'Book not found.' }, { status: 404 });
		}
	}
	return Response.json({ marks: documentMarks(doc.id), cardAnchors: cardAnchors(doc.id), sections: documentSections(doc.id), readRanges: doc.readRanges });
};

/** Reading position, rename, retry, chapter tags, or progress (chapters done, read up to a page, undo). */
export const POST: RequestHandler = async ({ params, request }) => {
	const doc = getDocument(params.id);
	if (!doc) return Response.json({ error: 'Book not found.' }, { status: 404 });
	const body = (await request.json().catch(() => ({}))) as {
		action?: string;
		page?: number;
		title?: string;
		sectionId?: string;
		sectionIds?: string[];
		done?: boolean;
		codes?: string[];
		ranges?: PageRange[];
		undoBatch?: string | null;
	};
	try {
		switch (body.action) {
			case 'position': {
				const page = Math.floor(Number(body.page) || 1);
				updateReadingPosition(doc.id, page);
				// Reaching the last planned page finishes a reading item in today's session.
				completeSessionWork({ readingDoc: doc.id, page });
				break;
			}
			case 'rename':
				renameDocument(doc.id, String(body.title ?? ''));
				break;
			case 'retry':
				retryDocument(doc.id);
				break;
			case 'section-codes':
				setSectionCodes(String(body.sectionId), Array.isArray(body.codes) ? body.codes.map(String) : []);
				break;
			case 'accept-suggestions':
				acceptAllSuggestions(doc.id);
				break;
			case 'mark-sections': {
				const ids = Array.isArray(body.sectionIds) ? body.sectionIds.map(String) : body.sectionId ? [String(body.sectionId)] : [];
				return Response.json(markSections(doc.id, ids, body.done !== false));
			}
			case 'read-up-to':
				return Response.json(setReadUpTo(doc.id, Number(body.page) || 0));
			case 'undo-progress': {
				// Undoes what linked decks did with the change, then puts the progress back.
				if (body.undoBatch) undoSuspendBatch(String(body.undoBatch));
				return Response.json(setRanges(doc.id, Array.isArray(body.ranges) ? body.ranges : [], 'Undo'));
			}
			default:
				return Response.json({ error: 'Unknown action.' }, { status: 400 });
		}
	} catch (err) {
		return Response.json({ error: err instanceof LibraryError ? err.message : 'Could not save.' }, { status: 400 });
	}
	return Response.json({ ok: true });
};

/** Deletes the book (a snapshot is taken first). Body: { deleteCards?: boolean }. */
export const DELETE: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as { deleteCards?: boolean };
	try {
		return Response.json(await deleteBook(params.id, { deleteCards: !!body.deleteCards }));
	} catch (err) {
		if (err instanceof LibraryError) return Response.json({ error: err.message }, { status: 404 });
		console.error(err);
		return Response.json({ error: 'Couldn’t delete the book. Nothing was lost: a snapshot was taken first.' }, { status: 500 });
	}
};

/** Anchors on this book that cards were made from, for margin markers in the reader. */
function cardAnchors(documentId: string) {
	return sqlite()
		.prepare(
			`SELECT a.id AS anchorId, a.page_number AS page, a.rects, n.id AS noteId, n.fields, n.note_type_id AS noteTypeId
			 FROM note n JOIN anchor a ON a.id = n.anchor_id
			 WHERE a.document_id = ? AND n.deleted_at IS NULL ORDER BY a.page_number`
		)
		.all(documentId)
		.map((r) => {
			const row = r as { anchorId: string; page: number; rects: string; noteId: string; fields: string; noteTypeId: string };
			return { ...row, rects: JSON.parse(row.rects) as number[][], fields: JSON.parse(row.fields) as Record<string, string> };
		});
}
