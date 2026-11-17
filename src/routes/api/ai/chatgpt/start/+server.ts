import { startSignIn } from '#lib/server/ai/chatgpt.js';
import type { RequestHandler } from './$types';

/** Begins "Sign in with ChatGPT". Returns the OpenAI page to open and whether it comes back by itself or needs pasting. */
export const POST: RequestHandler = async ({ request, url }) => {
	const body = (await request.json().catch(() => ({}))) as { forceConsent?: boolean };
	const { url: authUrl, mode } = startSignIn(url, { forceConsent: !!body.forceConsent });
	return Response.json({ url: authUrl, mode });
};
