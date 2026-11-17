import { verifyReplay } from '#lib/server/cards.js';
import type { RequestHandler } from './$types';

/** Replays every stored review and compares the result with each card's saved state. */
export const POST: RequestHandler = () => {
	const r = verifyReplay();
	return Response.json({ checked: r.checked, events: r.events, mismatches: r.mismatches.length, sample: r.mismatches.slice(0, 5) });
};
