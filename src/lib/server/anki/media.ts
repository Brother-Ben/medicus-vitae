import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { eq } from 'drizzle-orm';
import { db, kvGet, kvSet } from '../db';
import { media } from '../db/schema';
import { commitTmpFile, storedFileExists, storedFilePath } from '../files';

// Images, audio and fonts from Anki decks. Notes refer to files by name (as in
// Anki); the bytes are kept once in the file store under their SHA-256 hash.

export const MEDIA_TYPES: Record<string, string> = {
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	png: 'image/png',
	gif: 'image/gif',
	webp: 'image/webp',
	avif: 'image/avif',
	bmp: 'image/bmp',
	svg: 'image/svg+xml',
	ico: 'image/x-icon',
	tif: 'image/tiff',
	tiff: 'image/tiff',
	mp3: 'audio/mpeg',
	m4a: 'audio/mp4',
	aac: 'audio/aac',
	ogg: 'audio/ogg',
	oga: 'audio/ogg',
	opus: 'audio/ogg',
	wav: 'audio/wav',
	flac: 'audio/flac',
	mp4: 'video/mp4',
	m4v: 'video/mp4',
	webm: 'video/webm',
	ogv: 'video/ogg',
	mov: 'video/quicktime',
	css: 'text/css; charset=utf-8',
	ttf: 'font/ttf',
	otf: 'font/otf',
	woff: 'font/woff',
	woff2: 'font/woff2'
};

export function extOf(name: string) {
	const m = /\.([a-z0-9]{1,8})$/i.exec(name);
	return m ? m[1].toLowerCase() : 'bin';
}

export function contentTypeFor(ext: string) {
	// Anything that isn't plain media (e.g. a .js file a template referred to) is served as inert text.
	return MEDIA_TYPES[ext] ?? 'text/plain; charset=utf-8';
}

/** Types only the sealed card frame gets: scripts and data files that deck templates load. */
const FRAME_TYPES: Record<string, string> = { js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8', json: 'application/json' };

// ------------------------------------------------------- frame access keys
//
// Card frames have an opaque origin (that's what seals deck scripts off from
// Cortex), so the browser doesn't send the sign-in cookie with their requests.
// They load media through /api/media/k/<key>/<name> instead. The key is handed
// only to signed-in pages, changes every day, and opens nothing but media.

function keySecret(): Buffer {
	let s = kvGet<string | null>('media_key_secret', null);
	if (!s) {
		s = randomBytes(32).toString('hex');
		kvSet('media_key_secret', s);
	}
	return Buffer.from(s, 'hex');
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function keyForDay(day: string) {
	return createHmac('sha256', keySecret()).update(`media:${day}`).digest('base64url').slice(0, 32);
}

/** Where a signed-in page's card frames load media from today. */
export function mediaBase(now = Date.now()) {
	return `/api/media/k/${keyForDay(utcDay(now))}/`;
}

/** Today's and yesterday's keys work, so a page left open overnight keeps its images. */
export function mediaKeyValid(key: string, now = Date.now()) {
	const given = Buffer.from(key);
	return [now, now - 86_400_000].some((t) => {
		const k = Buffer.from(keyForDay(utcDay(t)));
		return k.length === given.length && timingSafeEqual(k, given);
	});
}

/**
 * A media file as an HTTP response. Responses can't run script if opened
 * directly (a deck's SVG, say), files never change so they cache well, and
 * audio/video players get byte ranges. `frame` is for the card frame's key
 * route: readable cross-origin (fonts need that) and scripts get a script type.
 */
export function mediaResponse(name: string, request: Request, frame = false): Response {
	const found = mediaFile(name);
	if (!found) return new Response('Not found', { status: 404 });
	const etag = `"${found.row.hash}"`;
	const headers: Record<string, string> = {
		'content-type': (frame && FRAME_TYPES[found.row.ext]) || contentTypeFor(found.row.ext),
		'cache-control': 'private, max-age=31536000, immutable',
		etag,
		'x-content-type-options': 'nosniff',
		'content-security-policy': "sandbox; default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; font-src 'self'"
	};
	if (frame) {
		headers['access-control-allow-origin'] = '*';
		headers['cross-origin-resource-policy'] = 'cross-origin';
	}
	if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers });
	const size = fs.statSync(found.path).size;
	const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
	if (range && (range[1] || range[2])) {
		let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
		let end = range[1] && range[2] ? Number(range[2]) : size - 1;
		start = Math.min(start, size - 1);
		end = Math.min(end, size - 1);
		if (start > end) return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${size}` } });
		const stream = Readable.toWeb(fs.createReadStream(found.path, { start, end })) as ReadableStream;
		return new Response(stream, {
			status: 206,
			headers: { ...headers, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${size}`, 'content-length': String(end - start + 1) }
		});
	}
	const stream = Readable.toWeb(fs.createReadStream(found.path)) as ReadableStream;
	return new Response(stream, { headers: { ...headers, 'accept-ranges': 'bytes', 'content-length': String(size) } });
}

export function sha256File(file: string): Promise<{ hash: string; size: number }> {
	return new Promise((resolve, reject) => {
		const h = createHash('sha256');
		let size = 0;
		fs.createReadStream(file)
			.on('data', (c) => {
				h.update(c as Buffer);
				size += (c as Buffer).length;
			})
			.on('error', reject)
			.on('end', () => resolve({ hash: h.digest('hex'), size }));
	});
}

export function mediaByName(name: string) {
	return db().select().from(media).where(eq(media.name, name)).get() ?? null;
}

/** Path of a stored media file, or null if the name is unknown or its bytes are missing. */
export function mediaFile(name: string) {
	const row = mediaByName(name) ?? mediaByName(name.normalize('NFC'));
	if (!row || !storedFileExists(row.hash, row.ext)) return null;
	return { path: storedFilePath(row.hash, row.ext), row };
}

/**
 * Stores a media file extracted from a package. When a different file already
 * uses that name, the new one gets a unique name (as Anki does) and the caller
 * rewrites the notes that refer to it. Returns the name notes should use.
 */
export async function storeMediaFile(tmpPath: string, name: string): Promise<{ name: string; added: boolean }> {
	const { hash, size } = await sha256File(tmpPath);
	const ext = extOf(name);
	let finalName = name;
	const existing = mediaByName(name);
	if (existing && existing.hash === hash) {
		// Same file again. Put its bytes back if they went missing (e.g. a restore without files).
		if (!storedFileExists(hash, existing.ext)) commitTmpFile(tmpPath, hash, existing.ext);
		else fs.rmSync(tmpPath, { force: true });
		return { name, added: false };
	}
	if (existing) {
		const dot = name.lastIndexOf('.');
		const base = dot > 0 ? name.slice(0, dot) : name;
		const suffix = dot > 0 ? name.slice(dot) : '';
		finalName = `${base}-${hash.slice(0, 8)}${suffix}`;
		const clash = mediaByName(finalName);
		if (clash && clash.hash === hash) {
			fs.rmSync(tmpPath, { force: true });
			return { name: finalName, added: false };
		}
	}
	commitTmpFile(tmpPath, hash, ext);
	db()
		.insert(media)
		.values({ name: finalName, hash, ext, size, createdAt: Date.now() })
		.onConflictDoUpdate({ target: media.name, set: { hash, ext, size } })
		.run();
	return { name: finalName, added: true };
}
