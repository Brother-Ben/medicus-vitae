import fs from 'node:fs';
import { storeMediaFile } from '#lib/server/anki/media.js';
import { receiveToTmp } from '#lib/server/files.js';
import type { RequestHandler } from './$types';

// An image for a card made here (image occlusion, or a picture in a field):
// PUT the bytes with ?name=. Stored like Anki media, so cards show it, exports
// carry it, and the Anki sync can send it to Anki.

const MAX = 25 * 1024 * 1024;

function kindOf(head: Buffer): string | null {
	if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
	if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'jpg';
	if (head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a') return 'gif';
	if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') return 'webp';
	return null;
}

export const PUT: RequestHandler = async ({ request, url }) => {
	if (!request.body) return Response.json({ error: 'No file received.' }, { status: 400 });
	if (Number(request.headers.get('content-length') ?? 0) > MAX) return Response.json({ error: 'That image is too big (25 MB at most).' }, { status: 413 });
	const received = await receiveToTmp(request.body);
	try {
		if (received.size > MAX) return Response.json({ error: 'That image is too big (25 MB at most).' }, { status: 413 });
		const ext = kindOf(received.head);
		if (!ext) return Response.json({ error: 'Use a PNG, JPEG, GIF or WebP image.' }, { status: 400 });
		const base = (url.searchParams.get('name') ?? 'image')
			.replace(/\.[a-z0-9]{1,5}$/i, '')
			.replace(/[^\w\- ]+/g, '')
			.trim()
			.slice(0, 60) || 'image';
		const stored = await storeMediaFile(received.tmpPath, `medicus-${base}-${received.hash.slice(0, 8)}.${ext}`);
		return Response.json({ name: stored.name });
	} finally {
		fs.rmSync(received.tmpPath, { force: true });
	}
};
