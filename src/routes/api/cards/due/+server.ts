import { CardError, deckCardIds, setCardsDue, type DueScope, type DueSpec } from '#lib/server/cards.js';
import type { RequestHandler } from './$types';

/**
 * Set due date: { cardIds } or { deck, scope: 'due' | 'review' | 'all' }, plus
 * { spec: { kind: 'date', date } | { kind: 'days', days } | { kind: 'range', min, max }, includeNew? }.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		cardIds?: string[];
		deck?: string;
		scope?: DueScope;
		spec?: DueSpec;
		includeNew?: boolean;
	};
	const spec = body.spec;
	if (!spec || !['date', 'days', 'range'].includes(spec.kind)) return Response.json({ error: 'Choose when the cards should come up.' }, { status: 400 });
	if (spec.kind === 'days' && !Number.isFinite(spec.days)) return Response.json({ error: 'Enter a number of days.' }, { status: 400 });
	if (spec.kind === 'range' && !(Number.isFinite(spec.min) && Number.isFinite(spec.max))) {
		return Response.json({ error: 'Enter the first and last day of the range.' }, { status: 400 });
	}
	let ids: string[] = [];
	if (Array.isArray(body.cardIds)) ids = body.cardIds.filter((x) => typeof x === 'string');
	else if (typeof body.deck === 'string' && body.deck) {
		const scope: DueScope = body.scope === 'review' || body.scope === 'all' ? body.scope : 'due';
		ids = deckCardIds(body.deck, scope);
	}
	if (!ids.length) return Response.json({ error: 'No cards to change.' }, { status: 400 });
	try {
		const includeNew = body.includeNew ?? (body.scope === 'all' || Array.isArray(body.cardIds));
		return Response.json(setCardsDue(ids, spec, { includeNew }));
	} catch (e) {
		if (e instanceof CardError) return Response.json({ error: e.message }, { status: 400 });
		console.error(e);
		return Response.json({ error: 'Could not change the due dates.' }, { status: 500 });
	}
};
