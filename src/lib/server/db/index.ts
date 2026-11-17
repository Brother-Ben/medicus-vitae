import fs from 'node:fs';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';
import { config } from '../config';

export type AppDb = BetterSQLite3Database<typeof schema> & { $client: Database.Database };

let mainSqlite: Database.Database | null = null;
let mainDb: AppDb | null = null;
let localSqlite: Database.Database | null = null;

/** The main database (owner data). Re-read on every use: a restore or standby refresh swaps it. */
export function db(): AppDb {
	if (!mainDb) throw new Error('Database is not open');
	return mainDb;
}

export function sqlite(): Database.Database {
	if (!mainSqlite) throw new Error('Database is not open');
	return mainSqlite;
}

/** Host-local database: sign-in sessions and this device's sync settings. Never copied. */
export function local(): Database.Database {
	if (!localSqlite) throw new Error('Local database is not open');
	return localSqlite;
}

export function isOpen() {
	return mainDb !== null;
}

/** Runs `fn` in a transaction on the main database, joining one that is already open. */
export function inTx<T>(fn: () => T): T {
	const conn = sqlite();
	if (conn.inTransaction) return fn();
	return conn.transaction(fn)();
}

function applyPragmas(conn: Database.Database) {
	conn.pragma('journal_mode = WAL');
	// FULL makes each commit durable on disk before the save is acknowledged.
	conn.pragma('synchronous = FULL');
	conn.pragma('foreign_keys = ON');
	conn.pragma('busy_timeout = 5000');
}

export function openSqliteFile(file: string, opts: { readonly?: boolean } = {}) {
	const conn = new Database(file, { readonly: opts.readonly ?? false, fileMustExist: opts.readonly ?? false });
	if (!opts.readonly) applyPragmas(conn);
	return conn;
}

interface MigrationEntry {
	tag: string;
	when: number;
}

function journal(): MigrationEntry[] {
	const raw = fs.readFileSync(`${config.paths.migrations}/meta/_journal.json`, 'utf8');
	return JSON.parse(raw).entries;
}

/** Migrations in the app that this database file hasn't had yet. */
export function pendingMigrations(conn: Database.Database): MigrationEntry[] {
	const hasTable = conn
		.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'`)
		.get();
	if (!hasTable) return journal();
	const row = conn.prepare(`SELECT max(created_at) AS last FROM __drizzle_migrations`).get() as {
		last: number | null;
	};
	const last = Number(row.last ?? 0);
	return journal().filter((e) => e.when > last);
}

/** True when the file has ever held owner data (so an upgrade needs a snapshot first). */
function hasOwnerData(conn: Database.Database): boolean {
	return !!conn.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'instance'`).get();
}

export interface OpenOptions {
	/** Called with the open connection before pending migrations run on an existing database. */
	beforeMigrate?: (conn: Database.Database, pending: MigrationEntry[]) => Promise<void>;
}

export function runMigrations(conn: Database.Database) {
	const d = drizzle(conn, { schema }) as AppDb;
	migrate(d, { migrationsFolder: config.paths.migrations });
	return d;
}

export async function openMainDatabase(opts: OpenOptions = {}) {
	if (mainDb) return;
	const conn = openSqliteFile(config.paths.mainDb);
	const pending = pendingMigrations(conn);
	if (pending.length && hasOwnerData(conn) && opts.beforeMigrate) {
		await opts.beforeMigrate(conn, pending);
	}
	mainDb = runMigrations(conn);
	mainSqlite = conn;
}

export function openLocalDatabase() {
	if (localSqlite) return;
	const conn = openSqliteFile(config.paths.localDb);
	conn.exec(`
		CREATE TABLE IF NOT EXISTS session (
			id TEXT PRIMARY KEY,
			stage TEXT NOT NULL DEFAULT 'full',
			created_at INTEGER NOT NULL,
			expires_at INTEGER NOT NULL,
			last_seen_at INTEGER NOT NULL,
			user_agent TEXT NOT NULL DEFAULT ''
		);
		CREATE TABLE IF NOT EXISTS kv (
			key TEXT PRIMARY KEY,
			value TEXT NOT NULL
		);
	`);
	localSqlite = conn;
}

export function closeMainDatabase() {
	if (mainSqlite) {
		try {
			mainSqlite.pragma('wal_checkpoint(TRUNCATE)');
		} catch {
			// Best effort: the WAL is replayed on next open anyway.
		}
		mainSqlite.close();
	}
	mainSqlite = null;
	mainDb = null;
}

export function closeDatabases() {
	closeMainDatabase();
	if (localSqlite) localSqlite.close();
	localSqlite = null;
}

/**
 * Replace the main database file with another one (restore from an export or a
 * standby applying its peer's snapshot). The current file is moved to `keepAs`
 * first so nothing is lost; WAL/SHM side files are cleared with it.
 */
export async function swapMainDatabase(newFile: string, keepAs: string | null, opts: OpenOptions = {}) {
	closeMainDatabase();
	const target = config.paths.mainDb;
	for (const suffix of ['-wal', '-shm']) {
		if (fs.existsSync(target + suffix)) fs.rmSync(target + suffix);
	}
	if (fs.existsSync(target)) {
		if (keepAs) fs.renameSync(target, keepAs);
		else fs.rmSync(target);
	}
	fs.renameSync(newFile, target);
	await openMainDatabase(opts);
}

// ------------------------------------------------------------ local kv

export function kvGet<T>(key: string, fallback: T): T {
	const row = local().prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
	if (!row) return fallback;
	try {
		return JSON.parse(row.value) as T;
	} catch {
		return fallback;
	}
}

export function kvSet(key: string, value: unknown) {
	local()
		.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
		.run(key, JSON.stringify(value));
}

export function kvDelete(key: string) {
	local().prepare('DELETE FROM kv WHERE key = ?').run(key);
}

export { schema };
