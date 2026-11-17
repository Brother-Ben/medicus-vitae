import { role } from '#lib/server/instance.js';
import { RESET_PARTS, resetData, ResetError, type ResetPart } from '#lib/server/reset.js';
import type { RequestHandler } from './$types';

/** Reset data: { parts: [...] } or { everything: true }, with { confirm: 'RESET' } typed by the owner. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { parts?: string[]; everything?: boolean; confirm?: string };
	if (role() !== 'primary') return Response.json({ error: 'Make this device primary first (Backups & sync).' }, { status: 409 });
	if (String(body.confirm ?? '').trim().toUpperCase() !== 'RESET') {
		return Response.json({ error: 'Type RESET to confirm.' }, { status: 400 });
	}
	const known = new Set<string>(RESET_PARTS.map((p) => p.id));
	const parts = (Array.isArray(body.parts) ? body.parts : []).filter((p): p is ResetPart => known.has(p));
	try {
		const r = await resetData(body.everything ? 'everything' : parts);
		return Response.json(r);
	} catch (e) {
		if (e instanceof ResetError) return Response.json({ error: e.message }, { status: 400 });
		console.error(e);
		return Response.json({ error: 'The reset didn’t finish. Nothing was lost: your data is in the snapshot taken just before.' }, { status: 500 });
	}
};
