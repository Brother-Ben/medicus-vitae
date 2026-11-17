import { error } from '@sveltejs/kit';
import { aiConnected } from '#lib/server/ai/providers.js';
import { storedFileExists } from '#lib/server/files.js';
import { documentSections, getDocument, pageSizes } from '#lib/server/library.js';
import { notesFiles, notesForBook } from '#lib/server/notes.js';
import { anchorView, documentMarks } from '#lib/server/reading.js';
import { sqlite } from '#lib/server/db/index.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, url }) => {
	const doc = getDocument(params.id);
	if (!doc) error(404, 'Book not found');
	const anchorId = url.searchParams.get('anchor');
	const target = anchorId ? anchorView(anchorId) : null;
	const pageParam = Number(url.searchParams.get('page'));
	const versionId = target?.versionId ?? doc.currentVersionId;
	const cardAnchors = sqlite()
		.prepare(
			`SELECT a.id AS anchorId, a.page_number AS page, a.rects, n.id AS noteId, n.fields, n.note_type_id AS noteTypeId
			 FROM note n JOIN anchor a ON a.id = n.anchor_id WHERE a.document_id = ? AND n.deleted_at IS NULL`
		)
		.all(doc.id)
		.map((r) => {
			const row = r as { anchorId: string; page: number; rects: string; noteId: string; fields: string; noteTypeId: string };
			return { ...row, rects: JSON.parse(row.rects) as number[][], fields: JSON.parse(row.fields) as Record<string, string> };
		});
	return {
		doc: {
			id: doc.id,
			title: doc.title,
			status: doc.status,
			error: doc.error,
			notice: doc.notice,
			pageCount: doc.pageCount ?? 0,
			versionId,
			fileMissing: !storedFileExists(doc.fileHash),
			lastPage: doc.lastPage ?? 1,
			readRanges: doc.readRanges ?? []
		},
		pages: versionId ? pageSizes(versionId) : [],
		sections: documentSections(doc.id),
		marks: documentMarks(doc.id),
		cardAnchors,
		target,
		initialPage: target?.page ?? (Number.isFinite(pageParam) && pageParam >= 1 ? Math.floor(pageParam) : (doc.lastPage ?? 1)),
		q: url.searchParams.get('q') ?? '',
		sessionId: url.searchParams.get('session'),
		/** A book: the owner's notes PDFs linked to its pages. A notes PDF: the book pages it covers. */
		role: doc.role,
		linkedNotes: doc.role === 'book' ? notesForBook(doc.id) : [],
		linkedBooks: doc.role === 'notes' ? (notesFiles().find((f) => f.id === doc.id)?.links ?? []) : [],
		/** The tutor tab and "Ask tutor" only appear with an AI service connected. */
		ai: aiConnected()
	};
};
