import { listChatgptModels } from '#lib/server/ai/chatgpt.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	try {
		return Response.json({ models: await listChatgptModels() });
	} catch (err) {
		return Response.json({ error: err instanceof Error ? err.message : 'Couldn’t list models.' }, { status: 502 });
	}
};
