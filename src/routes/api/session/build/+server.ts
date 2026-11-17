import { buildSession, type BuildOptions } from '#lib/server/planner.js';
import type { RequestHandler } from './$types';

/** A suggested plan for { minutes }, optionally kept to { deck | aamcCode | cardDocId } and { include }. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { minutes?: number } & BuildOptions;
	const minutes = Number(body.minutes);
	if (!Number.isFinite(minutes) || minutes < 5) return Response.json({ error: 'Pick at least 5 minutes.' }, { status: 400 });
	return Response.json(
		buildSession(minutes, {
			deck: body.deck ? String(body.deck) : null,
			aamcCode: body.aamcCode ? String(body.aamcCode) : null,
			cardDocId: body.cardDocId ? String(body.cardDocId) : null,
			include: body.include
		})
	);
};
