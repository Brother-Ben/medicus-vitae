import fs from 'node:fs';
import { Readable } from 'node:stream';
import { verifyPeerKey } from './peer';

// Helpers for the /api/peer/* endpoints the other device calls.

export function peerDenied(request: Request): Response | null {
	if (verifyPeerKey(request.headers.get('authorization'))) return null;
	return Response.json({ error: 'Pairing key required.' }, { status: 401 });
}

export function fileResponse(file: string, type: string) {
	const size = fs.statSync(file).size;
	return new Response(Readable.toWeb(fs.createReadStream(file)) as ReadableStream, {
		headers: { 'content-type': type, 'content-length': String(size), 'cache-control': 'no-store' }
	});
}
