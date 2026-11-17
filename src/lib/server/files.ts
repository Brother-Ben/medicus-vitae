import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config';
import { uuidv7 } from './ids';

// Original files are stored once, named by their SHA-256, and never modified.
// Snapshots only need to list which hashes they reference.

export function storedFilePath(hash: string, ext = 'pdf'): string {
	if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Bad file hash');
	return path.join(config.paths.files, hash.slice(0, 2), `${hash}.${ext}`);
}

export function storedFileExists(hash: string, ext = 'pdf'): boolean {
	try {
		return fs.statSync(storedFilePath(hash, ext)).isFile();
	} catch {
		return false;
	}
}

export interface ReceivedFile {
	tmpPath: string;
	hash: string;
	size: number;
	head: Buffer;
}

/** Streams an upload to data/tmp while hashing it. Nothing is kept if the stream fails. */
export async function receiveToTmp(body: ReadableStream<Uint8Array> | NodeJS.ReadableStream): Promise<ReceivedFile> {
	fs.mkdirSync(config.paths.tmp, { recursive: true });
	const tmpPath = path.join(config.paths.tmp, `upload-${uuidv7()}.part`);
	const hasher = createHash('sha256');
	let size = 0;
	let head = Buffer.alloc(0);
	const meter = new Transform({
		transform(chunk: Buffer, _enc, cb) {
			hasher.update(chunk);
			size += chunk.length;
			if (head.length < 1024) head = Buffer.concat([head, chunk.subarray(0, 1024 - head.length)]);
			cb(null, chunk);
		}
	});
	const source =
		typeof (body as ReadableStream).getReader === 'function'
			? Readable.fromWeb(body as import('node:stream/web').ReadableStream<Uint8Array>)
			: (body as NodeJS.ReadableStream);
	try {
		await pipeline(source, meter, fs.createWriteStream(tmpPath));
	} catch (err) {
		fs.rmSync(tmpPath, { force: true });
		throw err;
	}
	return { tmpPath, hash: hasher.digest('hex'), size, head };
}

/** Moves a received upload into the store (or drops it if that content is already stored). */
export function commitTmpFile(tmpPath: string, hash: string, ext = 'pdf') {
	const target = storedFilePath(hash, ext);
	if (fs.existsSync(target)) {
		fs.rmSync(tmpPath, { force: true });
		return target;
	}
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.renameSync(tmpPath, target);
	return target;
}

export function isPdfHeader(head: Buffer): boolean {
	// PDF readers accept the header anywhere in the first 1 KB.
	return head.includes(Buffer.from('%PDF-'));
}

/** All stored file hashes (for snapshot manifests). */
export function listStoredHashes(): { hash: string; ext: string; size: number }[] {
	const out: { hash: string; ext: string; size: number }[] = [];
	if (!fs.existsSync(config.paths.files)) return out;
	for (const dir of fs.readdirSync(config.paths.files)) {
		const full = path.join(config.paths.files, dir);
		if (!fs.statSync(full).isDirectory()) continue;
		for (const name of fs.readdirSync(full)) {
			const m = /^([a-f0-9]{64})\.([a-z0-9]+)$/.exec(name);
			if (m) out.push({ hash: m[1], ext: m[2], size: fs.statSync(path.join(full, name)).size });
		}
	}
	return out;
}

/** Removes leftovers from uploads that were interrupted. */
export function cleanTmp(olderThanMs = 6 * 3_600_000, keep: Set<string> = new Set()) {
	if (!fs.existsSync(config.paths.tmp)) return;
	const cutoff = Date.now() - olderThanMs;
	for (const name of fs.readdirSync(config.paths.tmp)) {
		const full = path.join(config.paths.tmp, name);
		if (keep.has(full)) continue;
		try {
			const st = fs.statSync(full);
			if (st.mtimeMs < cutoff) fs.rmSync(full, { recursive: true, force: true });
		} catch {
			// ignore
		}
	}
}
