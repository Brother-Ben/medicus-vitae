import { focusPrefs, updateFocusPrefs } from '#lib/server/settings.js';
import type { FocusPrefs } from '#lib/focus.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => Response.json({ prefs: focusPrefs() });

/** Save focus timer and break settings: any subset of FocusPrefs. */
export const POST: RequestHandler = async ({ request }) => {
	const patch = (await request.json().catch(() => ({}))) as Partial<FocusPrefs>;
	return Response.json({ prefs: updateFocusPrefs(patch) });
};
