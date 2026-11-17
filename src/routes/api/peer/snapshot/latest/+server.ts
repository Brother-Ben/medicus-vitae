import { snapshotForPeer } from '#lib/server/peer.js';
import { peerDenied } from '#lib/server/peer-http.js';
import type { RequestHandler } from './$types';

/** Newest snapshot of this device's data; ?fresh=1 makes a new one if anything changed. */
export const GET: RequestHandler = async ({ request, url }) => {
	const denied = peerDenied(request);
	if (denied) return denied;
	return Response.json(await snapshotForPeer(url.searchParams.get('fresh') === '1'));
};
