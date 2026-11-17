import { recordActivity } from '#lib/server/activity.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => null)) as {
		activity?: string;
		seconds?: number;
		documentId?: string | null;
		deviceId?: string;
	} | null;
	if (body) {
		recordActivity({
			activity: String(body.activity ?? ''),
			seconds: Number(body.seconds ?? 0),
			documentId: body.documentId ?? null,
			deviceId: String(body.deviceId ?? '')
		});
	}
	return new Response(null, { status: 204 });
};
