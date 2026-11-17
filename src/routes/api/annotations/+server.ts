import { inTx } from '#lib/server/db/index.js';
import {
	annotationHistory,
	createAnchor,
	createAnnotation,
	deleteAnnotation,
	ReadingError,
	updateAnnotation,
	type AnchorInput
} from '#lib/server/reading.js';
import type { RequestHandler } from './$types';

function err(e: unknown) {
	if (e instanceof ReadingError) return Response.json({ error: e.message }, { status: 400 });
	console.error(e);
	return Response.json({ error: 'Could not save the note.' }, { status: 500 });
}

/** Version history: ?id= */
export const GET: RequestHandler = ({ url }) => {
	const id = url.searchParams.get('id');
	if (!id) return Response.json({ error: 'Missing note.' }, { status: 400 });
	return Response.json({ revisions: annotationHistory(id) });
};

/** New note: { body, anchor? | anchorId?, documentId? } (anchored to a passage, or standalone). */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		body?: string;
		anchor?: AnchorInput;
		anchorId?: string;
		documentId?: string;
	};
	try {
		const id = inTx(() => {
			const anchorId = body.anchor ? createAnchor(body.anchor) : (body.anchorId ?? null);
			return createAnnotation({ anchorId, documentId: body.documentId ?? null, body: String(body.body ?? '') });
		});
		return Response.json({ id }, { status: 201 });
	} catch (e) {
		return err(e);
	}
};

/** Edit { id, body } or delete { id, delete: true }. */
export const PATCH: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { id?: string; body?: string; delete?: boolean };
	if (!body.id) return Response.json({ error: 'Missing note.' }, { status: 400 });
	try {
		if (body.delete) deleteAnnotation(body.id);
		else updateAnnotation(body.id, String(body.body ?? ''));
		return Response.json({ ok: true });
	} catch (e) {
		return err(e);
	}
};
