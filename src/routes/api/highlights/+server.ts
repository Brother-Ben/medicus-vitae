import { inTx } from '#lib/server/db/index.js';
import { createAnchor, createHighlight, deleteHighlight, ReadingError, recolorHighlight, type AnchorInput } from '#lib/server/reading.js';
import type { RequestHandler } from './$types';

function err(e: unknown) {
	if (e instanceof ReadingError) return Response.json({ error: e.message }, { status: 400 });
	console.error(e);
	return Response.json({ error: 'Could not save the highlight.' }, { status: 500 });
}

/** Create a highlight from a selection: { anchor, color }. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { anchor?: AnchorInput; color?: string };
	if (!body.anchor) return Response.json({ error: 'Nothing selected.' }, { status: 400 });
	try {
		const result = inTx(() => {
			const anchorId = createAnchor(body.anchor!);
			return { anchorId, id: createHighlight(anchorId, String(body.color ?? 'yellow')) };
		});
		return Response.json(result, { status: 201 });
	} catch (e) {
		return err(e);
	}
};

/** Recolor { id, color } or delete { id, delete: true }. */
export const PATCH: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { id?: string; color?: string; delete?: boolean };
	if (!body.id) return Response.json({ error: 'Missing highlight.' }, { status: 400 });
	try {
		if (body.delete) deleteHighlight(body.id);
		else recolorHighlight(body.id, String(body.color));
		return Response.json({ ok: true });
	} catch (e) {
		return err(e);
	}
};
