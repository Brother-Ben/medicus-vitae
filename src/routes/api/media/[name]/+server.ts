import { mediaResponse } from '#lib/server/anki/media.js';
import type { RequestHandler } from './$types';

// Images, audio and fonts from Anki decks, by the file name cards use (signed-in
// requests). Card frames use /api/media/k/<key>/<name> instead.

export const GET: RequestHandler = ({ params, request }) => mediaResponse(params.name, request);
