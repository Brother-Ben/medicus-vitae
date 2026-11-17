// Study sessions (Plan a session): the items in a plan and where each one opens.
// Shared by the server (planner.ts) and the browser (builder, session page, dock).

export type PlanItemType = 'reviews' | 'new' | 'retest' | 'repair' | 'reading' | 'custom';

export interface PlanItem {
	id: string;
	type: PlanItemType;
	title: string;
	detail: string;
	why: string;
	minutes: number;
	/** Cards: how many. */
	count?: number;
	/** Cards: only from this Anki deck (and its subdecks), AAMC category or book. */
	deck?: string | null;
	aamcCode?: string | null;
	cardDocId?: string | null;
	mistakeId?: string;
	/** Reading: the book and pages. */
	documentId?: string;
	fromPage?: number;
	toPage?: number;
	done?: boolean;
}

export const ITEM_ICON: Record<PlanItemType, string> = {
	reviews: 'cards',
	new: 'plus',
	retest: 'target',
	repair: 'journal',
	reading: 'book',
	custom: 'check'
};

/** Where an item is worked on. Custom tasks have no page of their own (null). */
export function itemHref(sessionId: string, item: PlanItem): string | null {
	const s = `session=${sessionId}&item=${item.id}`;
	switch (item.type) {
		case 'reviews':
		case 'new': {
			const p = new URLSearchParams();
			p.set('limit', String(item.count ?? 20));
			p.set('only', item.type === 'new' ? 'new' : 'due');
			if (item.deck) p.set('deck', item.deck);
			if (item.aamcCode) p.set('aamc', item.aamcCode);
			if (item.cardDocId) p.set('doc', item.cardDocId);
			return `/review?${p.toString()}&${s}`;
		}
		case 'retest':
		case 'repair':
			return `/mistakes/${item.mistakeId}?${s}`;
		case 'reading':
			return `/library/${item.documentId}/read?page=${item.fromPage ?? 1}&${s}`;
		case 'custom':
			return null;
	}
}

/** "Flashcards · Biochem › Enzymes" style label for a cards item's filter. */
export function cardsScope(item: Pick<PlanItem, 'deck' | 'aamcCode'>, docTitle?: string | null): string {
	if (item.deck) return item.deck.split('::').join(' › ');
	if (item.aamcCode) return item.aamcCode;
	if (docTitle) return docTitle;
	return 'All decks';
}
