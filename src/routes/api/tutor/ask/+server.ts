import type { ChatContext } from '#lib/server/db/schema.js';
import { AiError } from '#lib/server/ai/providers.js';
import { askTutor, TutorError } from '#lib/server/ai/tutor.js';
import { createAnchor, ReadingError, type AnchorInput } from '#lib/server/reading.js';
import type { RequestHandler } from './$types';

/**
 * Ask the tutor: { threadId?, question, mode?, context?, anchor? }. A reader
 * selection (anchor) is saved as an anchor first so the answer can cite it and
 * the conversation can link back to it.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		threadId?: string | null;
		question?: string;
		mode?: 'guide' | 'explain' | 'research';
		context?: ChatContext | null;
		anchor?: AnchorInput | null;
	};
	try {
		let context = body.context ?? null;
		if (body.anchor && !body.threadId) {
			const anchorId = createAnchor(body.anchor);
			context = { ...(context ?? { kind: 'selection' }), kind: 'selection', anchorId, documentId: body.anchor.documentId, page: body.anchor.page };
		}
		const result = await askTutor({ threadId: body.threadId ?? null, question: String(body.question ?? ''), mode: body.mode, context });
		return Response.json(result);
	} catch (err) {
		if (err instanceof AiError) return Response.json({ error: err.message, code: err.code, manageUrl: err.manageUrl }, { status: err.code === 'not_connected' ? 409 : 502 });
		if (err instanceof TutorError || err instanceof ReadingError) return Response.json({ error: err.message }, { status: 400 });
		console.error('Tutor failed:', err);
		return Response.json({ error: 'The tutor ran into a problem. Try again.' }, { status: 500 });
	}
};
