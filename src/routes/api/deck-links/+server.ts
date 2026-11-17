import { AiError } from '#lib/server/ai/providers.js';
import {
	aiSuggestMapping,
	autoMaps,
	DeckLinkError,
	deleteLink,
	listLinks,
	previewLink,
	saveLink,
	suggestMapping,
	type MapInput
} from '#lib/server/deck-links.js';
import { LibraryError } from '#lib/server/library.js';
import { undoSuspendBatch } from '#lib/server/suspend.js';
import type { RequestHandler } from './$types';

/**
 * ?documentId=&deck=: the book's chapters with likely tags or subdecks for each,
 * every candidate, and the automatic matches. Without a deck: the book's links.
 */
export const GET: RequestHandler = ({ url }) => {
	const documentId = url.searchParams.get('documentId') ?? '';
	const deck = url.searchParams.get('deck');
	try {
		if (!deck) return Response.json({ links: listLinks(documentId ? { documentId } : {}) });
		const s = suggestMapping(documentId, deck);
		return Response.json({ ...s, maps: autoMaps(s.sections) });
	} catch (err) {
		return fail(err);
	}
};

/**
 * { action: 'preview', documentId, deck, maps, suspendUnread } → what saving would do;
 * 'save' (with linkId to edit); 'ai-suggest'; 'delete' { linkId, restore }; 'undo' { batchId }.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		action?: string;
		linkId?: string | null;
		documentId?: string;
		deck?: string;
		maps?: MapInput[];
		suspendUnread?: boolean;
		restore?: boolean;
		batchId?: string;
	};
	try {
		switch (body.action) {
			case 'preview':
				return Response.json(previewLink(String(body.documentId), String(body.deck ?? ''), body.maps ?? [], body.suspendUnread !== false));
			case 'save':
				return Response.json(
					saveLink({ linkId: body.linkId ?? null, documentId: String(body.documentId), deck: String(body.deck ?? ''), maps: body.maps ?? [], suspendUnread: body.suspendUnread !== false })
				);
			case 'ai-suggest':
				return Response.json({ maps: await aiSuggestMapping(String(body.documentId), String(body.deck ?? '')) });
			case 'delete':
				return Response.json({ summary: deleteLink(String(body.linkId), { restore: !!body.restore }) });
			case 'undo':
				return Response.json(undoSuspendBatch(String(body.batchId ?? '')));
			default:
				return Response.json({ error: 'Unknown action.' }, { status: 400 });
		}
	} catch (err) {
		return fail(err);
	}
};

function fail(err: unknown) {
	if (err instanceof DeckLinkError || err instanceof LibraryError) return Response.json({ error: err.message }, { status: 400 });
	if (err instanceof AiError) return Response.json({ error: err.message, code: err.code, manageUrl: err.manageUrl }, { status: 502 });
	console.error(err);
	return Response.json({ error: 'Something went wrong with the deck link.' }, { status: 500 });
}
