import { deleteThread, getThread } from '#lib/server/ai/tutor.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const thread = getThread(params.id);
	if (!thread) return Response.json({ error: 'Conversation not found.' }, { status: 404 });
	return Response.json({ thread });
};

export const DELETE: RequestHandler = ({ params }) => {
	deleteThread(params.id);
	return Response.json({ ok: true });
};
