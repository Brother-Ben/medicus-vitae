import { clearSessionCookie, deleteSession } from '#lib/server/auth.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, cookies }) => {
	if (locals.session) deleteSession(locals.session.id);
	clearSessionCookie(cookies);
	return Response.json({ ok: true });
};
