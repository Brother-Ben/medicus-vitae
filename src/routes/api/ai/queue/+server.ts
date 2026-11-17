import { approveItem, approveUnflagged, discardItem, GenerateError } from '#lib/server/ai/generate.js';
import { CardError } from '#lib/server/cards.js';
import { ReadingError } from '#lib/server/reading.js';
import type { RequestHandler } from './$types';

/** { action: 'approve', id, edits? } | { action: 'discard', id } | { action: 'approve_all', ids } (skips flagged items). */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { action?: string; id?: string; ids?: string[]; edits?: Record<string, unknown> };
	try {
		if (body.action === 'approve' && body.id) return Response.json({ ref: approveItem(body.id, body.edits) });
		if (body.action === 'discard' && body.id) {
			discardItem(body.id);
			return Response.json({ ok: true });
		}
		if (body.action === 'approve_all') return Response.json({ approved: approveUnflagged((body.ids ?? []).map(String)) });
		return Response.json({ error: 'Unknown action.' }, { status: 400 });
	} catch (err) {
		if (err instanceof GenerateError || err instanceof CardError || err instanceof ReadingError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
};
