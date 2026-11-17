import { storedFileExists, storedFilePath } from '#lib/server/files.js';
import { fileResponse, peerDenied } from '#lib/server/peer-http.js';
import type { RequestHandler } from './$types';

/** A stored book or media file, by content hash: /api/peer/file/<sha256>.<ext> */
export const GET: RequestHandler = ({ request, params }) => {
	const denied = peerDenied(request);
	if (denied) return denied;
	const m = /^([a-f0-9]{64})\.([a-z0-9]{1,8})$/.exec(params.name);
	if (!m || !storedFileExists(m[1], m[2])) return Response.json({ error: 'File not found.' }, { status: 404 });
	return fileResponse(storedFilePath(m[1], m[2]), 'application/octet-stream');
};
