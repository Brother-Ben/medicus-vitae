import { cardDecks, leechCount, listCards, noteForEdit, queueCounts } from '#lib/server/cards.js';
import { carsToday } from '#lib/server/cars.js';
import { listLinks } from '#lib/server/deck-links.js';
import { getDocument } from '#lib/server/library.js';
import { studyClock } from '#lib/server/settings.js';
import type { PageServerLoad } from './$types';

const STATES = ['due', 'new', 'learning', 'review', 'suspended', 'leech'] as const;

export const load: PageServerLoad = ({ url, depends }) => {
	depends('app:cards');
	const stateParam = url.searchParams.get('state');
	const state = (STATES as readonly string[]).includes(stateParam ?? '') ? (stateParam as (typeof STATES)[number]) : null;
	const q = url.searchParams.get('q') ?? '';
	const aamc = url.searchParams.get('aamc');
	const docId = url.searchParams.get('doc');
	const deck = url.searchParams.get('deck');
	const limit = Math.min(500, Number(url.searchParams.get('limit')) || 50);
	const noteId = url.searchParams.get('note');
	const clock = studyClock();
	return {
		today: clock.today,
		q,
		state,
		aamc,
		docId,
		deck,
		docTitle: docId ? (getDocument(docId)?.title ?? null) : null,
		limit,
		list: listCards({ q, aamcCode: aamc, state, documentId: docId, deck, limit }),
		/** What "Study now" would show: the same deck, category or book as the list. */
		counts: queueCounts(clock, { aamcCode: aamc, documentId: docId, deck }),
		decks: cardDecks(clock),
		newLimitLeft: queueCounts(clock).newLimitLeft,
		leeches: leechCount(),
		editNote: noteId ? noteForEdit(noteId) : null,
		links: listLinks({ counts: false }).map((l) => ({ id: l.id, deck: l.deck, documentId: l.documentId, documentTitle: l.documentTitle })),
		carsWaiting: carsToday(clock).waiting
	};
};
