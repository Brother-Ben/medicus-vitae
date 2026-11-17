import fs from 'node:fs';
import { Readable } from 'node:stream';
import { storedFileExists, storedFilePath } from '#lib/server/files.js';
import { getDocument } from '#lib/server/library.js';
import type { RequestHandler } from './$types';

// The original PDF, for the reader. Supports range requests so PDF.js can load
// large books page by page. Content-addressed, so it never changes.

function stream(path: string, start?: number, end?: number) {
	return Readable.toWeb(fs.createReadStream(path, start === undefined ? undefined : { start, end })) as ReadableStream;
}

export const GET: RequestHandler = ({ params, request }) => {
	const doc = getDocument(params.id);
	if (!doc || !storedFileExists(doc.fileHash)) return new Response('Not found', { status: 404 });
	const file = storedFilePath(doc.fileHash);
	const size = fs.statSync(file).size;
	const headers: Record<string, string> = {
		'content-type': 'application/pdf',
		'accept-ranges': 'bytes',
		'cache-control': 'private, max-age=31536000, immutable',
		etag: `"${doc.fileHash}"`,
		'content-disposition': `inline; filename="${encodeURIComponent(doc.fileName)}"`
	};
	if (request.headers.get('if-none-match') === headers.etag) return new Response(null, { status: 304, headers });

	const range = request.headers.get('range');
	const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range.trim()) : null;
	if (m && (m[1] || m[2])) {
		let start = m[1] ? Number(m[1]) : size - Number(m[2]);
		let end = m[1] && m[2] ? Number(m[2]) : size - 1;
		if (!m[1]) end = size - 1;
		start = Math.max(0, start);
		end = Math.min(size - 1, end);
		if (start > end || start >= size) {
			return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
		}
		return new Response(stream(file, start, end), {
			status: 206,
			headers: { ...headers, 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) }
		});
	}
	return new Response(stream(file), { headers: { ...headers, 'content-length': String(size) } });
};
