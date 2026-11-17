import { randomBytes, randomInt } from 'node:crypto';

let lastMs = -1;
let counter = 0;

/**
 * UUID version 7 (RFC 9562): 48-bit millisecond timestamp, then a 12-bit
 * counter so IDs created in the same millisecond still sort in creation order.
 */
export function uuidv7(): string {
	let ms = Date.now();
	if (ms <= lastMs) {
		ms = lastMs;
		counter++;
		if (counter > 0xfff) {
			ms = ++lastMs;
			counter = 0;
		}
	} else {
		lastMs = ms;
		counter = randomInt(0, 0x400);
	}
	const b = randomBytes(16);
	for (let i = 0; i < 6; i++) b[i] = Math.floor(ms / 2 ** (8 * (5 - i))) % 256;
	b[6] = 0x70 | ((counter >>> 8) & 0x0f);
	b[7] = counter & 0xff;
	b[8] = 0x80 | (b[8] & 0x3f);
	const h = b.toString('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** A UUIDv7 stamped with a past time (imported review history), so ids still sort by when things happened. */
export function uuidv7At(ms: number): string {
	const b = randomBytes(16);
	const t = Math.max(0, Math.floor(ms));
	for (let i = 0; i < 6; i++) b[i] = Math.floor(t / 2 ** (8 * (5 - i))) % 256;
	b[6] = 0x70 | (b[6] & 0x0f);
	b[8] = 0x80 | (b[8] & 0x3f);
	const h = b.toString('hex');
	return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Random URL-safe token, e.g. for sessions and the peer pairing key. */
export function token(bytes = 32): string {
	return randomBytes(bytes).toString('base64url');
}

/** Anki-style note GUID: 10 random characters, so notes keep an identity if exported later. */
export function noteGuid(): string {
	const alphabet = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!#$%&()*+,-./:;<=>?@[]^_`{|}~';
	let out = '';
	for (let i = 0; i < 10; i++) out += alphabet[randomInt(0, alphabet.length)];
	return out;
}
