import { getSnapshot, snapshotDbPath } from '#lib/server/snapshots.js';
import { fileResponse, peerDenied } from '#lib/server/peer-http.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request, params }) => {
	const denied = peerDenied(request);
	if (denied) return denied;
	const meta = getSnapshot(params.id);
	if (!meta) return Response.json({ error: 'Snapshot not found.' }, { status: 404 });
	return fileResponse(snapshotDbPath(meta), 'application/gzip');
};
