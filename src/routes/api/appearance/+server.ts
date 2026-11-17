import { accountAppearance, saveAccountAppearance } from '#lib/server/appearance.js';
import type { RequestHandler } from './$types';

/** The account's appearance settings. */
export const GET: RequestHandler = () => Response.json({ appearance: accountAppearance() });

/** Changes some of them (Settings › Appearance applies changes at once and saves them here). */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
	if (!body || typeof body !== 'object') return Response.json({ error: 'Send the settings to change.' }, { status: 400 });
	return Response.json({ appearance: saveAccountAppearance(body) });
};
