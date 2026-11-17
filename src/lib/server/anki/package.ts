import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import yauzl from 'yauzl';
import { decodeMessage, getBytes, getFloat, getInt, getMessage, getRepeatedMessages, getString, has } from './protobuf';

// Reads Anki packages (.apkg, .colpkg): both the older formats
// (collection.anki2 / collection.anki21, media list as JSON) and the newer
// compressed one (collection.anki21b with zstd, media list as protobuf, every
// media file zstd-compressed). See rslib/src/import_export/package in Anki.

export class PackageError extends Error {}

export type PackageVersion = 'legacy1' | 'legacy2' | 'latest';

export interface MediaEntry {
	/** File name notes refer to. */
	name: string;
	/** Entry name inside the zip ("0", "1", …). */
	zipName: string;
}

export interface OpenedPackage {
	version: PackageVersion;
	collectionPath: string;
	media: MediaEntry[];
	close(): void;
	/** Writes one media file, decompressed, to `dest`. */
	extractMedia(entry: MediaEntry, dest: string): Promise<void>;
}

function openZip(file: string): Promise<yauzl.ZipFile> {
	return new Promise((resolve, reject) =>
		yauzl.open(file, { lazyEntries: true, autoClose: false, decodeStrings: true }, (err, zip) => (err || !zip ? reject(err ?? new Error('zip')) : resolve(zip)))
	);
}

function readEntries(zip: yauzl.ZipFile): Promise<Map<string, yauzl.Entry>> {
	return new Promise((resolve, reject) => {
		const entries = new Map<string, yauzl.Entry>();
		zip.on('entry', (e: yauzl.Entry) => {
			entries.set(e.fileName, e);
			zip.readEntry();
		});
		zip.on('end', () => resolve(entries));
		zip.on('error', reject);
		zip.readEntry();
	});
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
	return new Promise((resolve, reject) => zip.openReadStream(entry, (err, s) => (err || !s ? reject(err ?? new Error('stream')) : resolve(s))));
}

async function entryBuffer(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<Buffer> {
	const chunks: Buffer[] = [];
	for await (const c of await entryStream(zip, entry)) chunks.push(c as Buffer);
	return Buffer.concat(chunks);
}

/** Whether `head` (first bytes of a file) looks like a zip archive. */
export function isZipHeader(head: Buffer) {
	return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && head[2] === 0x03 && head[3] === 0x04;
}

/** Opens a package and extracts its collection database into `workDir`. */
export async function openPackage(file: string, workDir: string): Promise<OpenedPackage> {
	let zip: yauzl.ZipFile;
	try {
		zip = await openZip(file);
	} catch {
		throw new PackageError('That file isn’t a readable Anki package (.apkg or .colpkg).');
	}
	try {
		const entries = await readEntries(zip);
		let version: PackageVersion;
		const meta = entries.get('meta');
		if (meta) {
			const v = getInt(decodeMessage(await entryBuffer(zip, meta)), 1);
			if (v === 3) version = 'latest';
			else if (v === 2) version = 'legacy2';
			else if (v === 1) version = 'legacy1';
			else throw new PackageError('This package was made by a newer version of Anki than Medicus Vitae understands.');
		} else {
			version = entries.has('collection.anki21') ? 'legacy2' : 'legacy1';
		}
		const colName = version === 'latest' ? 'collection.anki21b' : version === 'legacy2' ? 'collection.anki21' : 'collection.anki2';
		const colEntry = entries.get(colName);
		if (!colEntry) throw new PackageError(`The package has no ${colName} inside, so it can’t be imported.`);
		const compressed = version === 'latest';

		fs.mkdirSync(workDir, { recursive: true });
		const collectionPath = path.join(workDir, 'collection.sqlite');
		const src = await entryStream(zip, colEntry);
		if (compressed) await pipeline(src, zlib.createZstdDecompress(), fs.createWriteStream(collectionPath));
		else await pipeline(src, fs.createWriteStream(collectionPath));
		useKnownCollations(collectionPath);

		// Media list: JSON {"0": "name.jpg"} in old packages, protobuf MediaEntries (zstd) in new ones.
		const media: MediaEntry[] = [];
		const mediaEntry = entries.get('media');
		if (mediaEntry) {
			let raw = await entryBuffer(zip, mediaEntry);
			if (compressed) raw = zlib.zstdDecompressSync(raw);
			if (compressed) {
				const list = getRepeatedMessages(decodeMessage(raw), 1);
				list.forEach((m, index) => {
					const name = getString(m, 1);
					const legacy = has(m, 255) ? String(getInt(m, 255)) : null;
					if (name) media.push({ name: name.normalize('NFC'), zipName: legacy ?? String(index) });
				});
			} else {
				const text = raw.toString('utf8').trim() || '{}';
				let map: Record<string, string>;
				try {
					map = JSON.parse(text);
				} catch {
					throw new PackageError('The package’s media list is damaged.');
				}
				for (const [zipName, name] of Object.entries(map)) {
					if (typeof name === 'string' && name) media.push({ name: name.normalize('NFC'), zipName });
				}
			}
		}
		const safeMedia = media.filter((m) => entries.has(m.zipName) && safeFileName(m.name));

		return {
			version,
			collectionPath,
			media: safeMedia,
			close: () => zip.close(),
			async extractMedia(entry, dest) {
				const e = entries.get(entry.zipName);
				if (!e) throw new PackageError(`Media file ${entry.name} is missing from the package.`);
				const s = await entryStream(zip, e);
				if (compressed) await pipeline(s, zlib.createZstdDecompress(), fs.createWriteStream(dest));
				else await pipeline(s, fs.createWriteStream(dest));
			}
		};
	} catch (err) {
		zip.close();
		throw err;
	}
}

/**
 * Anki's newer collections declare their own "unicase" collation on name columns
 * (note types, fields, templates, decks, tags). SQLite won't read a WITHOUT ROWID
 * table, or compare a column, whose collation it doesn't know, and better-sqlite3
 * can't register one. The extracted file is our own copy, so its schema is
 * switched to SQLite's NOCASE. Nothing reads rows of it by name, so the indexes'
 * original order doesn't matter.
 */
export function useKnownCollations(file: string) {
	let db: Database.Database | null = null;
	try {
		db = new Database(file, { fileMustExist: true });
		const rows = db.prepare(`SELECT type, name, sql FROM sqlite_master WHERE sql LIKE '%unicase%'`).all() as { type: string; name: string; sql: string }[];
		if (!rows.length) return;
		db.unsafeMode(true);
		db.pragma('writable_schema = ON');
		const update = db.prepare('UPDATE sqlite_master SET sql = ? WHERE type = ? AND name = ?');
		db.transaction(() => {
			for (const r of rows) update.run(r.sql.replace(/\bcollate\s+["'`[]?unicase["'`\]]?/gi, 'COLLATE NOCASE'), r.type, r.name);
		})();
		db.pragma('writable_schema = OFF');
	} catch {
		throw new PackageError('The collection inside the package couldn’t be read. The package may be damaged.');
	} finally {
		db?.close();
	}
}

/** Anki refuses media names with path separators or reserved names; so do we. */
export function safeFileName(name: string) {
	return !!name && !/[\\/:*?"<>|\u0000-\u001f]/.test(name) && name !== '.' && name !== '..' && name.length <= 255;
}

// ------------------------------------------------------------- collection

export interface AnkiNoteType {
	id: number;
	name: string;
	kind: 'standard' | 'cloze';
	fields: string[];
	templates: { name: string; front: string; back: string }[];
	css: string;
	sortField: number;
	/** Anki's own marker for its image occlusion note type (stock kind 6). */
	stockImageOcclusion: boolean;
}

export interface AnkiDeck {
	id: number;
	name: string;
	configId: number | null;
	filtered: boolean;
	desiredRetention: number | null;
}

export interface AnkiDeckConfig {
	id: number;
	name: string;
	desiredRetention: number | null;
	leechThreshold: number | null;
}

export interface AnkiNote {
	id: number;
	guid: string;
	mid: number;
	mod: number;
	tags: string[];
	fields: string[];
}

export interface AnkiCard {
	id: number;
	nid: number;
	did: number;
	odid: number;
	ord: number;
	type: number;
	queue: number;
	/** For a new card (type 0), its position in the deck's new-card order. */
	due: number;
	ivl: number;
}

export interface AnkiReview {
	id: number;
	cid: number;
	ease: number;
	ivl: number;
	type: number;
	time: number;
}

export interface CollectionInfo {
	schema: number;
	noteTypes: Map<number, AnkiNoteType>;
	decks: Map<number, AnkiDeck>;
	deckConfigs: Map<number, AnkiDeckConfig>;
	noteCount: number;
	cardCount: number;
	revlogCount: number;
}

function tableExists(db: Database.Database, name: string) {
	return !!db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name);
}

export function openCollection(file: string) {
	try {
		const db = new Database(file, { readonly: true, fileMustExist: true });
		db.prepare('SELECT count(*) FROM notes').get();
		return db;
	} catch {
		throw new PackageError('The collection inside the package couldn’t be read. The package may be damaged.');
	}
}

const isStockIo = (kind: number) => kind === 6;

function noteTypesV18(db: Database.Database): Map<number, AnkiNoteType> {
	const out = new Map<number, AnkiNoteType>();
	const types = db.prepare('SELECT id, name, config FROM notetypes').all() as { id: number; name: string; config: Buffer }[];
	const fieldsStmt = db.prepare('SELECT name FROM fields WHERE ntid = ? ORDER BY ord');
	const tmplStmt = db.prepare('SELECT name, config FROM templates WHERE ntid = ? ORDER BY ord');
	for (const t of types) {
		const cfg = decodeMessage(t.config ?? Buffer.alloc(0));
		const fields = (fieldsStmt.all(t.id) as { name: string }[]).map((f) => f.name);
		const templates = (tmplStmt.all(t.id) as { name: string; config: Buffer }[]).map((r) => {
			const c = decodeMessage(r.config ?? Buffer.alloc(0));
			return { name: r.name, front: getString(c, 1), back: getString(c, 2) };
		});
		out.set(t.id, {
			id: t.id,
			name: t.name,
			kind: getInt(cfg, 1) === 1 ? 'cloze' : 'standard',
			fields,
			templates,
			css: getString(cfg, 3),
			sortField: getInt(cfg, 2),
			stockImageOcclusion: isStockIo(getInt(cfg, 9))
		});
	}
	return out;
}

function noteTypesV11(raw: string): Map<number, AnkiNoteType> {
	const out = new Map<number, AnkiNoteType>();
	let models: Record<string, Record<string, unknown>> = {};
	try {
		models = JSON.parse(raw || '{}');
	} catch {
		throw new PackageError('The note types in this package are damaged.');
	}
	for (const m of Object.values(models)) {
		const flds = ((m.flds as { name: string; ord: number }[]) ?? []).slice().sort((a, b) => a.ord - b.ord);
		const tmpls = ((m.tmpls as { name: string; ord: number; qfmt: string; afmt: string }[]) ?? []).slice().sort((a, b) => a.ord - b.ord);
		const id = Number(m.id);
		out.set(id, {
			id,
			name: String(m.name ?? 'Note type'),
			kind: Number(m.type) === 1 ? 'cloze' : 'standard',
			fields: flds.map((f) => f.name),
			templates: tmpls.map((t) => ({ name: t.name, front: t.qfmt ?? '', back: t.afmt ?? '' })),
			css: String(m.css ?? ''),
			sortField: Number(m.sortf ?? 0),
			stockImageOcclusion: isStockIo(Number(m.originalStockKind ?? 0))
		});
	}
	return out;
}

function decksV18(db: Database.Database) {
	const decks = new Map<number, AnkiDeck>();
	for (const d of db.prepare('SELECT id, name, kind FROM decks').all() as { id: number; name: string; kind: Buffer }[]) {
		const kind = decodeMessage(d.kind ?? Buffer.alloc(0));
		const normal = getMessage(kind, 1);
		decks.set(d.id, {
			id: d.id,
			name: d.name.replace(/\u001f/g, '::'),
			configId: normal ? getInt(normal, 1) : null,
			filtered: !normal && !!getBytes(kind, 2),
			desiredRetention: normal ? getFloat(normal, 10) : null
		});
	}
	const configs = new Map<number, AnkiDeckConfig>();
	if (tableExists(db, 'deck_config')) {
		for (const c of db.prepare('SELECT id, name, config FROM deck_config').all() as { id: number; name: string; config: Buffer }[]) {
			const cfg = decodeMessage(c.config ?? Buffer.alloc(0));
			configs.set(c.id, {
				id: c.id,
				name: c.name,
				desiredRetention: getFloat(cfg, 37),
				leechThreshold: has(cfg, 22) ? getInt(cfg, 22) : null
			});
		}
	}
	return { decks, configs };
}

function decksV11(rawDecks: string, rawConf: string) {
	const decks = new Map<number, AnkiDeck>();
	const configs = new Map<number, AnkiDeckConfig>();
	try {
		for (const d of Object.values(JSON.parse(rawDecks || '{}') as Record<string, Record<string, unknown>>)) {
			const id = Number(d.id);
			decks.set(id, {
				id,
				name: String(d.name ?? 'Default'),
				configId: d.dyn ? null : Number(d.conf ?? 1),
				filtered: !!d.dyn,
				desiredRetention: typeof d.desiredRetention === 'number' ? d.desiredRetention : null
			});
		}
		for (const c of Object.values(JSON.parse(rawConf || '{}') as Record<string, Record<string, unknown>>)) {
			const id = Number(c.id);
			const lapse = (c.lapse ?? {}) as Record<string, unknown>;
			configs.set(id, {
				id,
				name: String(c.name ?? 'Default'),
				desiredRetention: typeof c.desiredRetention === 'number' ? c.desiredRetention : null,
				leechThreshold: typeof lapse.leechFails === 'number' ? lapse.leechFails : null
			});
		}
	} catch {
		// Deck names are cosmetic; a damaged deck list just means no deck names.
	}
	return { decks, configs };
}

export function readCollectionInfo(db: Database.Database): CollectionInfo {
	const col = db.prepare('SELECT ver, models, decks, dconf FROM col LIMIT 1').get() as
		| { ver: number; models: string; decks: string; dconf: string }
		| undefined;
	if (!col) throw new PackageError('The collection inside the package is empty or damaged.');
	const v18 = tableExists(db, 'notetypes') && (db.prepare('SELECT count(*) AS n FROM notetypes').get() as { n: number }).n > 0;
	const noteTypes = v18 ? noteTypesV18(db) : noteTypesV11(col.models);
	const { decks, configs } = tableExists(db, 'decks') && v18 ? decksV18(db) : decksV11(col.decks, col.dconf);
	const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
	return {
		schema: col.ver,
		noteTypes,
		decks,
		deckConfigs: configs,
		noteCount: count('SELECT count(*) AS n FROM notes'),
		cardCount: count('SELECT count(*) AS n FROM cards'),
		revlogCount: tableExists(db, 'revlog') ? count('SELECT count(*) AS n FROM revlog') : 0
	};
}

/** Notes in id order, a batch at a time (so a large deck doesn't hold up the server). */
export function* noteBatches(db: Database.Database, size = 1000): Generator<AnkiNote[]> {
	const stmt = db.prepare('SELECT id, guid, mid, mod, tags, flds FROM notes WHERE id > ? ORDER BY id LIMIT ?');
	let after = Number.MIN_SAFE_INTEGER;
	for (;;) {
		const rows = stmt.all(after, size) as { id: number; guid: string; mid: number; mod: number; tags: string; flds: string }[];
		if (!rows.length) return;
		after = rows[rows.length - 1].id;
		yield rows.map((r) => ({
			id: r.id,
			guid: r.guid,
			mid: r.mid,
			mod: r.mod,
			tags: String(r.tags ?? '')
				.split(/\s+/)
				.map((t) => t.trim())
				.filter(Boolean),
			fields: String(r.flds ?? '').split('\u001f')
		}));
	}
}

export function cardsForNotes(db: Database.Database, noteIds: number[]): AnkiCard[] {
	if (!noteIds.length) return [];
	const out: AnkiCard[] = [];
	for (let i = 0; i < noteIds.length; i += 500) {
		const chunk = noteIds.slice(i, i + 500);
		out.push(
			...(db
				.prepare(`SELECT id, nid, did, odid, ord, type, queue, due, ivl FROM cards WHERE nid IN (${chunk.map(() => '?').join(',')}) ORDER BY nid, ord`)
				.all(...chunk) as AnkiCard[])
		);
	}
	return out;
}

export function reviewsForCards(db: Database.Database, cardIds: number[]): AnkiReview[] {
	if (!cardIds.length || !tableExists(db, 'revlog')) return [];
	const out: AnkiReview[] = [];
	for (let i = 0; i < cardIds.length; i += 500) {
		const chunk = cardIds.slice(i, i + 500);
		out.push(
			...(db
				.prepare(`SELECT id, cid, ease, ivl, type, time FROM revlog WHERE cid IN (${chunk.map(() => '?').join(',')}) ORDER BY id`)
				.all(...chunk) as AnkiReview[])
		);
	}
	return out;
}

/** Card scheduling overview, to tell "exported without scheduling" from "never studied". */
export function schedulingSummary(db: Database.Database) {
	return db
		.prepare(`SELECT sum(CASE WHEN type != 0 THEN 1 ELSE 0 END) AS studied, count(*) AS total FROM cards`)
		.get() as { studied: number | null; total: number };
}
