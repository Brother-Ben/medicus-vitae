import fs from 'node:fs';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { config } from '../config';

// The search index the tutor and meaning search use (AI-08): passages
// ("chunks") from books, figures, the owner's reading notes and cards, a
// keyword index over them, and one embedding per passage from a small local
// model. It is derived data kept per device (data/index.sqlite): never in
// snapshots or exports, and rebuilt whenever it's missing or the model changes.

/** The local embedding model. Vectors from different models are never compared. */
export const EMBEDDING_MODEL = {
	id: 'Xenova/bge-small-en-v1.5',
	revision: 'ea104dacec62c0de699686887e3f920caeb4f3e3',
	dtype: 'q8',
	dims: 384,
	distance: 'cosine',
	pooling: 'cls',
	/** BGE models expect this before search queries (not before passages). */
	queryPrefix: 'Represent this sentence for searching relevant passages: '
} as const;

export const CHUNKER_VERSION = '1';

let conn: Database.Database | null = null;
let vecLoaded = false;

function createSchema(db: Database.Database) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
		CREATE TABLE IF NOT EXISTS chunk (
			id INTEGER PRIMARY KEY,
			key TEXT NOT NULL UNIQUE,
			kind TEXT NOT NULL,
			provenance TEXT NOT NULL,
			doc_id TEXT,
			version_id TEXT,
			page INTEGER,
			text_start INTEGER,
			text_end INTEGER,
			rects TEXT,
			ref_id TEXT,
			section TEXT,
			text TEXT NOT NULL,
			hash TEXT NOT NULL,
			embedded INTEGER NOT NULL DEFAULT 0
		);
		CREATE INDEX IF NOT EXISTS chunk_version ON chunk (version_id);
		CREATE INDEX IF NOT EXISTS chunk_kind_ref ON chunk (kind, ref_id);
		CREATE INDEX IF NOT EXISTS chunk_pending ON chunk (embedded) WHERE embedded = 0;
		CREATE VIRTUAL TABLE IF NOT EXISTS chunk_fts USING fts5(
			text, content = 'chunk', content_rowid = 'id', tokenize = 'porter unicode61 remove_diacritics 2'
		);
		CREATE TRIGGER IF NOT EXISTS chunk_ai AFTER INSERT ON chunk BEGIN
			INSERT INTO chunk_fts (rowid, text) VALUES (new.id, new.text);
		END;
		CREATE TRIGGER IF NOT EXISTS chunk_ad AFTER DELETE ON chunk BEGIN
			INSERT INTO chunk_fts (chunk_fts, rowid, text) VALUES ('delete', old.id, old.text);
		END;
	`);
}

function ensureVectorTable(db: Database.Database) {
	if (!vecLoaded) return;
	const m = EMBEDDING_MODEL;
	const want = JSON.stringify({ id: m.id, revision: m.revision, dtype: m.dtype, dims: m.dims, distance: m.distance, pooling: m.pooling });
	const have = (db.prepare(`SELECT value FROM meta WHERE key = 'embedding_model'`).get() as { value: string } | undefined)?.value;
	if (have !== want) {
		// A different model (or none yet): start the vectors over.
		db.exec('DROP TABLE IF EXISTS chunk_vec');
		db.prepare('UPDATE chunk SET embedded = 0').run();
		db.prepare(`INSERT INTO meta (key, value) VALUES ('embedding_model', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(want);
	}
	db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(embedding float[${m.dims}] distance_metric=${m.distance})`);
}

export function indexDb(): Database.Database {
	if (conn) return conn;
	fs.mkdirSync(config.dataDir, { recursive: true });
	const db = new Database(config.paths.indexDb);
	db.pragma('journal_mode = WAL');
	// Derived data: losing the last moment of it on a crash is fine.
	db.pragma('synchronous = NORMAL');
	db.pragma('busy_timeout = 5000');
	try {
		sqliteVec.load(db);
		vecLoaded = true;
	} catch (err) {
		vecLoaded = false;
		console.warn('Meaning search is unavailable (sqlite-vec could not load):', err instanceof Error ? err.message : err);
	}
	createSchema(db);
	const version = (db.prepare(`SELECT value FROM meta WHERE key = 'chunker'`).get() as { value: string } | undefined)?.value;
	if (version !== CHUNKER_VERSION) {
		db.exec('DELETE FROM chunk');
		db.exec('DROP TABLE IF EXISTS chunk_vec');
		db.prepare(`INSERT INTO meta (key, value) VALUES ('chunker', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(CHUNKER_VERSION);
	}
	ensureVectorTable(db);
	conn = db;
	return db;
}

export function vectorsAvailable() {
	indexDb();
	return vecLoaded && config.embeddings;
}

export function closeIndexDb() {
	conn?.close();
	conn = null;
}

export function metaGet(key: string): string | null {
	return (indexDb().prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}

export function metaSet(key: string, value: string) {
	indexDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

export interface ChunkRow {
	id: number;
	key: string;
	kind: 'page' | 'figure' | 'annotation' | 'card';
	provenance: string;
	doc_id: string | null;
	version_id: string | null;
	page: number | null;
	text_start: number | null;
	text_end: number | null;
	rects: string | null;
	ref_id: string | null;
	section: string | null;
	text: string;
	hash: string;
	embedded: number;
}

export function indexStats() {
	const db = indexDb();
	const row = db.prepare('SELECT count(*) AS total, sum(embedded) AS embedded FROM chunk').get() as { total: number; embedded: number | null };
	const kinds = db.prepare('SELECT kind, count(*) AS n FROM chunk GROUP BY kind').all() as { kind: string; n: number }[];
	return { total: row.total, embedded: row.embedded ?? 0, kinds: Object.fromEntries(kinds.map((k) => [k.kind, k.n])) };
}

/** Deletes chunks (and their vectors) by id. */
export function deleteChunks(ids: number[]) {
	if (!ids.length) return;
	const db = indexDb();
	const del = db.prepare('DELETE FROM chunk WHERE id = ?');
	const delVec = vecLoaded ? db.prepare('DELETE FROM chunk_vec WHERE rowid = ?') : null;
	db.transaction(() => {
		for (const id of ids) {
			del.run(id);
			delVec?.run(BigInt(id));
		}
	})();
}
