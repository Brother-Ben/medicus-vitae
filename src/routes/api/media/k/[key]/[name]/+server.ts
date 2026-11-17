import { mediaKeyValid, mediaResponse } from '#lib/server/anki/media.js';
import type { RequestHandler } from './$types';

// Media for the sealed card frame (no sign-in cookie reaches it): the key in the
// path stands in for the sign-in. See mediaBase() in media.ts.

export const GET: RequestHandler = ({ params, request }) => {
	if (!mediaKeyValid(params.key)) return new Response('Not found', { status: 404 });
	return mediaResponse(params.name, request, true);
};
