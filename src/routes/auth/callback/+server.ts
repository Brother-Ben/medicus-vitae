import { redirect } from '@sveltejs/kit';
import { ChatgptError, completeSignIn, isPendingState } from '#lib/server/ai/chatgpt.js';
import { activeProviderId, setActiveProvider } from '#lib/server/ai/providers.js';
import type { RequestHandler } from './$types';

// Where "Sign in with ChatGPT" returns (http://127.0.0.1:<port>/auth/callback).
// Reachable without a session: the one-time `state` from the sign-in that was
// started here is what ties the result to it. A callback meant for the app on
// another computer (or an expired attempt) gets a page explaining what to do.

function page(title: string, body: string, status = 200) {
	// A standalone page outside the app's layout: Clinic Light / Clinic Dark colors from themes.css.
	const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>:root{--bg:#F3F6F5;--surface:#FFFFFF;--surface-2:#EDF2F1;--border:#DCE3E2;--border-strong:#C3CDCB;--text:#13201F}
@media (prefers-color-scheme:dark){:root{--bg:#0E1413;--surface:#161F1E;--surface-2:#1D2827;--border:#263230;--border-strong:#34423F;--text:#E5EDEB}}
body{font-family:system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:var(--text);background:var(--bg)}main{background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:1.5rem}
textarea{width:100%;box-sizing:border-box;font:13px ui-monospace,monospace;padding:.5rem;border-radius:8px;border:1px solid var(--border-strong);background:var(--surface-2);color:var(--text)}h1{font-size:1.25rem;margin:0 0 .5rem}</style>
</head><body><main>${body}</main></body></html>`;
	return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export const GET: RequestHandler = async ({ url }) => {
	const state = url.searchParams.get('state');
	if (!isPendingState(state)) {
		return page(
			'Finish signing in',
			`<h1>Finish signing in in Medicus Vitae</h1><p>This sign-in was started from Medicus Vitae on another computer (or it has expired). Copy this whole address and paste it into Medicus Vitae under <strong>Settings › AI</strong>:</p>
<textarea rows="5" readonly onclick="this.select()">${url.href.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</textarea>`
		);
	}
	try {
		const r = await completeSignIn(url.searchParams);
		if (r.planUsage && !activeProviderId()) setActiveProvider('chatgpt');
		redirect(303, `${r.returnTo}?connected=chatgpt`);
	} catch (err) {
		if (err instanceof ChatgptError) return page('Sign-in failed', `<h1>Sign-in didn’t finish</h1><p>${err.message.replace(/</g, '&lt;')}</p><p>Go back to Medicus Vitae › Settings › AI and try again.</p>`, 400);
		throw err;
	}
};
