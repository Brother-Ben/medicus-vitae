import { createHash, timingSafeEqual } from 'node:crypto';
import { config } from '#lib/server/config.js';
import { requestQuit } from '#lib/server/lifecycle.js';
import type { RequestHandler } from './$types';

/** For the launcher (tray app): stop the server using the token it passed in CORTEX_CONTROL_TOKEN. */
export const POST: RequestHandler = ({ request }) => {
	const given = request.headers.get('x-cortex-control') ?? '';
	if (!config.controlToken) return new Response('Not available', { status: 404 });
	const a = createHash('sha256').update(given).digest();
	const b = createHash('sha256').update(config.controlToken).digest();
	if (!timingSafeEqual(a, b)) return new Response('Forbidden', { status: 403 });
	requestQuit();
	return Response.json({ ok: true });
};
