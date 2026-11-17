import { ChatgptError, completeSignIn } from '#lib/server/ai/chatgpt.js';
import { activeProviderId, setActiveProvider } from '#lib/server/ai/providers.js';
import type { RequestHandler } from './$types';

/** Finishes a sign-in from the address the owner pasted (when Cortex runs on another computer). */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { url?: string };
	let query: URLSearchParams;
	try {
		const raw = String(body.url ?? '').trim();
		query = new URL(raw.includes('://') ? raw : `http://x/?${raw.replace(/^\?/, '')}`).searchParams;
	} catch {
		return Response.json({ error: 'Paste the whole address from the browser’s address bar.' }, { status: 400 });
	}
	try {
		const r = await completeSignIn(query);
		if (r.planUsage && !activeProviderId()) setActiveProvider('chatgpt');
		return Response.json({ planUsage: r.planUsage });
	} catch (err) {
		if (err instanceof ChatgptError) return Response.json({ error: err.message }, { status: 400 });
		console.error('ChatGPT sign-in failed:', err);
		return Response.json({ error: 'Sign-in failed. Try again.' }, { status: 500 });
	}
};
