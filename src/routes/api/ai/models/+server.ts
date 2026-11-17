import { KEY_PROVIDERS, listModels, type KeyProviderId } from '#lib/server/ai/providers.js';
import type { RequestHandler } from './$types';

/** Models a connection offers (?provider=gemini|openrouter|custom), for the picker in Settings › AI. */
export const GET: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('provider') ?? '';
	if (!(KEY_PROVIDERS as string[]).includes(id)) return Response.json({ models: [] });
	return Response.json({ models: (await listModels(id as KeyProviderId)).slice(0, 600) });
};
