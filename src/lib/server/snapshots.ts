import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import { config } from './config';
import { sqlite } from './db';
import { hostId, hostName, isPrimary } from './instance';

// Snapshots (SYNC-01): consistent copies of the database made with SQLite's
// backup API while the app runs, gzipped, plus a manifest of the original
// files they need (those never change, so they're listed rather than copied).
// Kept: hourly for 48 hours, daily for 30 days, and the latest of other kinds.

export type SnapshotType =
	| 'hourly'
	| 'daily'
	| 'manual'
	| 'pre-upgrade'
	| 'pre-restore'
	| 'pre-reset'
	| 'pre-delete'
	| 'pre-promotion'
	| 'handoff'
	| 'peer';

export interface SnapshotMeta {
	id: string;
	type: SnapshotType;
	createdAt: number;
	dbFile: string;
	dbSize: number;
	dbSha256: string;
	rawSize: number;
	files: { hash: string; ext: string; size: number }[];
	installationId: string | null;
	sourceHostId: string;
	sourceHostName: string;
	generation: number;
	primaryHostId: string | null;
	writeSeq: number;
	appVersion: string;
	schemaTag: string | null;
}

let busy: Promise<unknown> = Promise.resolve();

/** Snapshots run one at a time. */
function serialize<T>(fn: () => Promise<T>): Promise<T> {
	const next = busy.then(fn, fn);
	busy = next.catch(() => {});
	return next;
}

function stamp(ms: number) {
	return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

/** Facts about a database file (instance row, file manifest, schema). */
export function inspectDatabase(file: string) {
	const conn = new Database(file, { readonly: true, fileMustExist: true });
	try {
		const inst = conn
			.prepare('SELECT installation_id, generation, primary_host_id, write_seq, promoted_from FROM instance WHERE id = 1')
			.get() as
			| { installation_id: string; generation: number; primary_host_id: string; write_seq: number; promoted_from: string | null }
			| undefined;
		const files = conn.prepare('SELECT DISTINCT file_hash, kind, file_size FROM document').all() as {
			file_hash: string;
			kind: string;
			file_size: number;
		}[];
		// Images and audio from Anki decks (databases from before Anki import have no media table).
		const media = conn.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'media'").get()
			? (conn.prepare('SELECT DISTINCT hash AS file_hash, ext AS kind, size AS file_size FROM media').all() as typeof files)
			: [];
		const seen = new Set(files.map((f) => `${f.file_hash}.${f.kind}`));
		for (const m of media) if (!seen.has(`${m.file_hash}.${m.kind}`)) files.push(m);
		let schemaTag: string | null = null;
		try {
			const row = conn.prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1').get() as
				| { created_at: number }
				| undefined;
			schemaTag = row ? String(row.created_at) : null;
		} catch {
			schemaTag = null;
		}
		const hasUser = !!(conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='user'").get() &&
			conn.prepare('SELECT 1 FROM user WHERE id = 1').get());
		return {
			installationId: inst?.installation_id ?? null,
			generation: inst?.generation ?? 0,
			primaryHostId: inst?.primary_host_id ?? null,
			writeSeq: inst?.write_seq ?? 0,
			promotedFrom: inst?.promoted_from ? JSON.parse(inst.promoted_from) : null,
			files: files.map((f) => ({ hash: f.file_hash, ext: f.kind === 'pdf' ? 'pdf' : f.kind, size: f.file_size })),
			schemaTag,
			hasUser
		};
	} finally {
		conn.close();
	}
}

/**
 * A backup copy inherits WAL mode from the live database, so reading it would
 * create -wal/-shm side files. Switch the copy to a plain rollback journal so it
 * is one self-contained file (the app turns WAL back on when it opens it).
 */
export function finalizeBackupFile(file: string) {
	const conn = new Database(file);
	try {
		conn.pragma('journal_mode = DELETE');
	} finally {
		conn.close();
	}
}

/** Deletes a database file and any side files SQLite left next to it. */
export function removeDbFile(file: string) {
	for (const suffix of ['', '-wal', '-shm', '-journal']) fs.rmSync(file + suffix, { force: true });
}

export function integrityOk(file: string): boolean {
	const conn = new Database(file, { readonly: true, fileMustExist: true });
	try {
		const r = conn.pragma('quick_check', { simple: true });
		return r === 'ok';
	} catch {
		return false;
	} finally {
		conn.close();
	}
}

async function gzipFile(src: string, dest: string) {
	const hasher = createHash('sha256');
	let size = 0;
	const meter = new Transform({
		transform(chunk: Buffer, _e, cb) {
			hasher.update(chunk);
			size += chunk.length;
			cb(null, chunk);
		}
	});
	await pipeline(fs.createReadStream(src), zlib.createGzip({ level: 6 }), meter, fs.createWriteStream(dest));
	return { sha256: hasher.digest('hex'), size };
}

export async function gunzipFile(src: string, dest: string) {
	await pipeline(fs.createReadStream(src), zlib.createGunzip(), fs.createWriteStream(dest));
}

export function sha256File(file: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const h = createHash('sha256');
		fs.createReadStream(file)
			.on('data', (c) => h.update(c))
			.on('error', reject)
			.on('end', () => resolve(h.digest('hex')));
	});
}

/** Back up a live connection (default: the main database) into a gzipped snapshot. */
export function createSnapshot(type: SnapshotType, conn?: Database.Database): Promise<SnapshotMeta> {
	return serialize(async () => {
		fs.mkdirSync(config.paths.snapshots, { recursive: true });
		const createdAt = Date.now();
		const id = `${stamp(createdAt)}-${type}-${Math.random().toString(36).slice(2, 6)}`;
		const rawPath = path.join(config.paths.snapshots, `${id}.sqlite.tmp`);
		const gzName = `${id}.sqlite.gz`;
		const gzPath = path.join(config.paths.snapshots, gzName);
		try {
			await (conn ?? sqlite()).backup(rawPath);
			finalizeBackupFile(rawPath);
			const facts = inspectDatabase(rawPath);
			const rawSize = fs.statSync(rawPath).size;
			const { sha256, size } = await gzipFile(rawPath, gzPath);
			const meta: SnapshotMeta = {
				id,
				type,
				createdAt,
				dbFile: gzName,
				dbSize: size,
				dbSha256: sha256,
				rawSize,
				files: facts.files,
				installationId: facts.installationId,
				sourceHostId: hostId(),
				sourceHostName: hostName(),
				generation: facts.generation,
				primaryHostId: facts.primaryHostId,
				writeSeq: facts.writeSeq,
				appVersion: config.version,
				schemaTag: facts.schemaTag
			};
			writeMeta(meta);
			return meta;
		} finally {
			removeDbFile(rawPath);
		}
	}).then((meta) => {
		pruneSnapshots();
		return meta;
	});
}

export function writeMeta(meta: SnapshotMeta) {
	const metaPath = path.join(config.paths.snapshots, `${meta.id}.json`);
	fs.writeFileSync(metaPath + '.tmp', JSON.stringify(meta, null, 2));
	fs.renameSync(metaPath + '.tmp', metaPath);
}

export function listSnapshots(): SnapshotMeta[] {
	if (!fs.existsSync(config.paths.snapshots)) return [];
	const out: SnapshotMeta[] = [];
	for (const name of fs.readdirSync(config.paths.snapshots)) {
		if (!name.endsWith('.json')) continue;
		try {
			const meta = JSON.parse(fs.readFileSync(path.join(config.paths.snapshots, name), 'utf8')) as SnapshotMeta;
			if (fs.existsSync(path.join(config.paths.snapshots, meta.dbFile))) out.push(meta);
		} catch {
			// ignore damaged metadata
		}
	}
	return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function getSnapshot(id: string): SnapshotMeta | null {
	if (!/^[A-Za-z0-9-]+$/.test(id)) return null;
	return listSnapshots().find((s) => s.id === id) ?? null;
}

export function snapshotDbPath(meta: SnapshotMeta) {
	return path.join(config.paths.snapshots, meta.dbFile);
}

export function deleteSnapshot(meta: SnapshotMeta) {
	fs.rmSync(path.join(config.paths.snapshots, meta.dbFile), { force: true });
	fs.rmSync(path.join(config.paths.snapshots, `${meta.id}.json`), { force: true });
}

/** Apply retention. The newest snapshot of every type is always kept. */
export function pruneSnapshots(now = Date.now()) {
	const all = listSnapshots();
	const byType = new Map<string, SnapshotMeta[]>();
	for (const s of all) {
		const list = byType.get(s.type) ?? [];
		list.push(s);
		byType.set(s.type, list);
	}
	for (const [type, list] of byType) {
		list.sort((a, b) => b.createdAt - a.createdAt);
		list.forEach((s, i) => {
			if (i === 0) return;
			const age = now - s.createdAt;
			let drop = false;
			if (type === 'hourly') drop = age > config.snapshots.hourlyKeepHours * 3_600_000;
			else if (type === 'daily') drop = age > config.snapshots.dailyKeepDays * 86_400_000;
			else if (type === 'manual') drop = i >= config.snapshots.manualKeep;
			else drop = i >= config.snapshots.preUpgradeKeep;
			if (drop) deleteSnapshot(s);
		});
	}
	// Clean temp files (and their SQLite side files) from interrupted snapshots.
	for (const name of fs.readdirSync(config.paths.snapshots)) {
		if (name.includes('.sqlite.tmp') || name.endsWith('.json.tmp')) {
			const full = path.join(config.paths.snapshots, name);
			if (now - fs.statSync(full).mtimeMs > 3_600_000) fs.rmSync(full, { force: true });
		}
	}
}

export function latestSnapshot(types?: SnapshotType[]): SnapshotMeta | null {
	return listSnapshots().find((s) => !types || types.includes(s.type)) ?? null;
}

function currentWriteSeq(): number {
	try {
		const r = sqlite().prepare('SELECT write_seq FROM instance WHERE id = 1').get() as { write_seq: number } | undefined;
		return r?.write_seq ?? 0;
	} catch {
		return 0;
	}
}

/** True when the database changed since the newest snapshot of these types. */
export function changedSince(types: SnapshotType[]): boolean {
	const last = latestSnapshot(types);
	return !last || last.writeSeq !== currentWriteSeq() || last.sourceHostId !== hostId();
}

function hasAccount(): boolean {
	try {
		return !!sqlite().prepare('SELECT 1 FROM user WHERE id = 1').get();
	} catch {
		return false;
	}
}

/** Called every minute: hourly and daily snapshots on the primary, only when something changed. */
export async function scheduledSnapshots(now = Date.now()) {
	if (!config.snapshots.enabled || !isPrimary() || !hasAccount()) return;
	const lastHourly = latestSnapshot(['hourly']);
	if ((!lastHourly || now - lastHourly.createdAt >= 3_600_000) && changedSince(['hourly', 'daily', 'manual', 'pre-upgrade'])) {
		await createSnapshot('hourly');
	}
	const lastDaily = latestSnapshot(['daily']);
	if ((!lastDaily || now - lastDaily.createdAt >= 86_400_000) && changedSince(['daily'])) {
		await createSnapshot('daily');
	}
}

/** Before migrations run on an existing database file. */
export async function preUpgradeSnapshot(conn: Database.Database) {
	await createSnapshot('pre-upgrade', conn);
}
