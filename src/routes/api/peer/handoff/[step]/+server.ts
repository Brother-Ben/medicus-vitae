import { cancelHandoff, completeHandoff, localStatus, prepareHandoff } from '#lib/server/peer.js';
import { peerDenied } from '#lib/server/peer-http.js';
import type { RequestHandler } from './$types';

/** The other device is becoming primary: prepare (stop and snapshot), complete, or cancel. */
export const POST: RequestHandler = async ({ request, params }) => {
	const denied = peerDenied(request);
	if (denied) return denied;
	if (params.step === 'prepare') return Response.json(await prepareHandoff());
	if (params.step === 'complete') {
		const body = (await request.json().catch(() => ({}))) as { primaryHostId?: string; generation?: number };
		await completeHandoff(String(body.primaryHostId ?? ''), Number(body.generation ?? 0));
		return Response.json({ ok: true, status: localStatus() });
	}
	if (params.step === 'cancel') {
		cancelHandoff();
		return Response.json({ ok: true, status: localStatus() });
	}
	return Response.json({ error: 'Unknown step.' }, { status: 404 });
};
