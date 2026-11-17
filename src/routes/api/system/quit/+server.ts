import { config } from '#lib/server/config.js';
import { requestQuit } from '#lib/server/lifecycle.js';
import type { RequestHandler } from './$types';

/** The Quit button in the web UI. Signed-in only (enforced in hooks). */
export const POST: RequestHandler = () => {
	if (!config.allowQuit) {
		return Response.json(
			{ error: 'Quitting from the browser is turned off here (in Docker, stop the container instead).' },
			{ status: 403 }
		);
	}
	requestQuit();
	return Response.json({ ok: true });
};
