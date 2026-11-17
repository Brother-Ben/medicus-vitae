import { setGuideDone } from '#lib/server/guide.js';
import type { RequestHandler } from './$types';

/** { done: true } once the first-time guide is finished or skipped; { done: false } to show it again. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { done?: unknown };
	setGuideDone(body.done !== false);
	return Response.json({ ok: true });
};
