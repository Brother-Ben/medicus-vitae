import { error } from '@sveltejs/kit';
import { aiConnected } from '#lib/server/ai/providers.js';
import { cardDecks } from '#lib/server/cards.js';
import { listLinks } from '#lib/server/deck-links.js';
import { documentSections, getDocument, listDocuments } from '#lib/server/library.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, depends }) => {
	depends('app:book');
	const doc = getDocument(params.id);
	if (!doc) error(404, 'Book not found');
	const summary = listDocuments().find((d) => d.id === doc.id);
	return {
		book: {
			id: doc.id,
			title: doc.title,
			fileName: doc.fileName,
			status: doc.status,
			error: doc.error,
			notice: doc.notice,
			pageCount: doc.pageCount,
			createdAt: doc.createdAt,
			lastPage: doc.lastPage,
			highlights: summary?.highlights ?? 0,
			annotations: summary?.annotations ?? 0,
			cards: summary?.cards ?? 0,
			readRanges: doc.readRanges ?? [],
			done: summary?.done ?? { pct: 0, pagesDone: 0, pageCount: doc.pageCount ?? 0, sectionsDone: 0, sectionsTotal: 0 }
		},
		sections: documentSections(doc.id),
		links: listLinks({ documentId: doc.id }),
		decks: cardDecks().map((d) => ({ deck: d.deck, label: d.label, depth: d.depth, cards: d.cards })),
		ai: aiConnected()
	};
};
