import { inArray } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { annotation, document, note } from '#lib/server/db/schema.js';
import { kindForNoteType, notePreview } from '#lib/cards.js';
import { meaningSearch } from '#lib/server/ai/retrieval.js';
import { search, type SearchKind } from '#lib/server/search.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const q = url.searchParams.get('q') ?? '';
	const kind = url.searchParams.get('kind') as SearchKind | null;
	const kinds = kind && ['page', 'annotation', 'card'].includes(kind) ? [kind] : undefined;

	// Meaning search (AI-08): closest passages by the local embedding model. Needs no AI service.
	if (url.searchParams.get('mode') === 'meaning' && q.trim()) {
		const { passages, usedMeaning } = await meaningSearch(q, 30);
		const filtered = passages.filter((p) => !kinds || kinds.includes(p.kind === 'figure' ? 'page' : (p.kind as SearchKind)));
		return {
			q,
			kind,
			mode: 'meaning' as const,
			usedMeaning,
			total: filtered.length,
			hits: filtered.map((p) => ({
				kind: (p.kind === 'figure' ? 'page' : p.kind) as SearchKind,
				refId: `${p.chunkId}`,
				docId: p.docId,
				page: p.page,
				score: p.score,
				segments: [{ text: p.text.length > 320 ? p.text.slice(0, 319) + '…' : p.text, hit: false }],
				title: p.label,
				href:
					p.kind === 'card' && p.refId
						? `/cards?note=${p.refId}`
						: p.kind === 'annotation'
							? p.docId && p.page
								? `/library/${p.docId}/read?page=${p.page}`
								: '/notes'
							: `/library/${p.docId}/read?page=${p.page ?? 1}`
			}))
		};
	}

	const { hits, total } = search(q, { kinds, limit: 60 });

	const docIds = [...new Set(hits.map((h) => h.docId).filter((x): x is string => !!x))];
	const titles = new Map(
		(docIds.length ? db().select({ id: document.id, title: document.title }).from(document).where(inArray(document.id, docIds)).all() : []).map(
			(d) => [d.id, d.title]
		)
	);
	const annIds = hits.filter((h) => h.kind === 'annotation').map((h) => h.refId);
	const anns = new Map(
		(annIds.length ? db().select().from(annotation).where(inArray(annotation.id, annIds)).all() : []).map((a) => [a.id, a])
	);
	const noteIds = hits.filter((h) => h.kind === 'card').map((h) => h.refId);
	const notes = new Map((noteIds.length ? db().select().from(note).where(inArray(note.id, noteIds)).all() : []).map((n) => [n.id, n]));

	return {
		q,
		kind,
		mode: 'keyword' as const,
		usedMeaning: false,
		total,
		hits: hits.map((h) => {
			const title = h.docId ? (titles.get(h.docId) ?? 'Missing book') : null;
			if (h.kind === 'page') {
				return { ...h, title: `${title} · page ${h.page}`, href: `/library/${h.docId}/read?page=${h.page}&q=${encodeURIComponent(q)}` };
			}
			if (h.kind === 'annotation') {
				const a = anns.get(h.refId);
				return {
					...h,
					title: `Note${title ? ` · ${title}` : ''}${h.page ? ` · page ${h.page}` : ''}`,
					href: a?.anchorId && h.docId ? `/library/${h.docId}/read?anchor=${a.anchorId}` : '/notes'
				};
			}
			const n = notes.get(h.refId);
			return {
				...h,
				title: n ? `Card · ${notePreview(kindForNoteType(n.noteTypeId), n.fields, 80)}` : 'Card',
				href: `/cards?note=${h.refId}`
			};
		})
	};
};
