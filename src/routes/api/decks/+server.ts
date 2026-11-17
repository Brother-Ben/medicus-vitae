import { deckDeletePreview, deleteDeck, DeleteError, restoreDeleted, type DeletedCards } from '#lib/server/deletion.js';
import type { RequestHandler } from './$types';

/** What deleting a deck would remove: ?deck= */
export const GET: RequestHandler = ({ url }) => {
	const deck = url.searchParams.get('deck') ?? '';
	if (!deck) return Response.json({ error: 'Which deck?' }, { status: 400 });
	return Response.json(deckDeletePreview(deck));
};

/** { action: 'delete', deck, alsoInAnki? } or { action: 'restore', deleted } (Undo). */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { action?: string; deck?: string; alsoInAnki?: boolean; deleted?: DeletedCards };
	try {
		if (body.action === 'delete') return Response.json(await deleteDeck(String(body.deck ?? ''), { alsoInAnki: !!body.alsoInAnki }));
		if (body.action === 'restore' && body.deleted) return Response.json(restoreDeleted(body.deleted));
		return Response.json({ error: 'Unknown action.' }, { status: 400 });
	} catch (e) {
		if (e instanceof DeleteError) return Response.json({ error: e.message }, { status: 400 });
		console.error(e);
		return Response.json({ error: 'Couldn’t delete the deck. Nothing was lost: a snapshot was taken first.' }, { status: 500 });
	}
};
