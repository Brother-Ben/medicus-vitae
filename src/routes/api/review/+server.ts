import { CardError, nextLearningDue, nextReviewCard, queueCounts, reviewCard, submitReview, type QueueFilter } from '#lib/server/cards.js';
import { studyClock } from '#lib/server/settings.js';
import type { RequestHandler } from './$types';

function filterFrom(params: URLSearchParams | Record<string, unknown>): QueueFilter {
	const get = (k: string) => (params instanceof URLSearchParams ? params.get(k) : (params[k] as string | null | undefined));
	const only = get('only');
	return { aamcCode: get('aamc') || null, documentId: get('doc') || null, deck: get('deck') || null, only: only === 'due' || only === 'new' ? only : null };
}

function excludeFrom(v: unknown): string[] {
	if (Array.isArray(v)) return v.map(String).slice(0, 500);
	if (typeof v === 'string' && v) return v.split(',').slice(0, 500);
	return [];
}

/** The next card and the counts, both for the same filter (deck, category or book). */
function next(exclude: string[], filter: QueueFilter) {
	const card = nextReviewCard(exclude, filter);
	const clock = studyClock();
	return { card, counts: queueCounts(clock, filter), nextLearningDue: card ? null : nextLearningDue(clock, filter) };
}

/** The next card to study (?exclude=id,id&aamc=&doc=&deck=), or one card by id (?card=). */
export const GET: RequestHandler = ({ url }) => {
	const one = url.searchParams.get('card');
	if (one) return Response.json({ card: reviewCard(one) });
	return Response.json(next(excludeFrom(url.searchParams.get('exclude')), filterFrom(url.searchParams)));
};

/** Save a review and return the next card. Safe to retry: the same eventId is saved once. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		const result = submitReview({
			cardId: String(body.cardId ?? ''),
			rating: Number(body.rating),
			confidence: (body.confidence as never) ?? null,
			eventId: String(body.eventId ?? ''),
			timeTakenMs: Number(body.timeTakenMs ?? 0),
			deviceId: String(body.deviceId ?? ''),
			deviceSeq: Number(body.deviceSeq ?? 0),
			baseRev: Number(body.baseRev ?? -1)
		});
		return Response.json({ result, ...next(excludeFrom(body.exclude), filterFrom(body)) });
	} catch (err) {
		if (err instanceof CardError) return Response.json({ error: err.message }, { status: 400 });
		console.error(err);
		return Response.json({ error: 'The review could not be saved.' }, { status: 500 });
	}
};
