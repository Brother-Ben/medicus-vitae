import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { marked } from 'marked';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { kindForNoteType, NOTE_KINDS } from '../cards';
import { config } from './config';
import { sqlite, swapMainDatabase } from './db';
import { commitTmpFile, storedFileExists, storedFilePath } from './files';
import { hostId, setRole } from './instance';
import { uuidv7 } from './ids';
import { clearSchedulerCache } from './fsrs';
import {
	createSnapshot,
	finalizeBackupFile,
	gunzipFile,
	inspectDatabase,
	integrityOk,
	preUpgradeSnapshot,
	removeDbFile,
	snapshotDbPath,
	type SnapshotMeta
} from './snapshots';

// DATA-01: a full export (database + original files + readable copies) that a
// fresh installation can restore with nothing missing, plus a cards CSV.

export const EXPORT_FORMAT = 'cortex-export';
export const EXPORT_FORMAT_VERSION = 1;

/** Owner data tables written as readable JSON. Derived data (page text, search index) is rebuilt from the books. */
const JSON_TABLES = [
	'document',
	'document_version',
	'doc_section',
	'anchor',
	'highlight',
	'annotation',
	'annotation_revision',
	'note_type',
	'note',
	'card',
	'scheduler_config',
	'review_event',
	'card_due_change',
	'note_link',
	'ai_summary',
	'anki_sync_deck',
	'anki_push',
	'tombstone',
	'question',
	'practice_set',
	'full_length',
	'mistake',
	'mistake_link',
	'mistake_event',
	'attempt',
	'study_session',
	'session_plan',
	'media',
	'chat_thread',
	'chat_message',
	'generated_item',
	'ai_usage',
	'card_suspend_change',
	'deck_book_link',
	'deck_book_map',
	'full_length_item',
	'cars_passage',
	'cars_question',
	'cars_attempt'
];

function csvCell(v: string) {
	return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function mdToHtml(md: string) {
	return (marked.parse(md, { async: false }) as string).trim();
}

/**
 * Cards as a CSV that Anki's "Import File" understands (stock Basic, Basic
 * (and reversed card) and Cloze note types; HTML fields; AAMC codes as tags).
 */
export function cardsCsv(conn: Database.Database = sqlite()): string {
	const rows = conn
		.prepare(
			`SELECT n.guid, n.note_type_id, n.fields, n.tags, n.aamc_code FROM note n
			 WHERE n.deleted_at IS NULL ORDER BY n.created_at`
		)
		.all() as { guid: string; note_type_id: string; fields: string; tags: string; aamc_code: string | null }[];
	const lines = [
		'#separator:Comma',
		'#html:true',
		'#guid column:1',
		'#notetype column:2',
		'#tags column:5',
		'GUID,Note type,Front or Text,Back or Back Extra,Tags'
	];
	const ankiName: Record<string, string> = {
		basic: 'Basic',
		basic_reversed: 'Basic (and reversed card)',
		cloze: 'Cloze'
	};
	const typeNames = new Map(
		(conn.prepare('SELECT id, name FROM note_type').all() as { id: string; name: string }[]).map((t) => [t.id, t.name])
	);
	for (const r of rows) {
		const kind = kindForNoteType(r.note_type_id);
		const fields = JSON.parse(r.fields) as Record<string, string>;
		const tags = [...(JSON.parse(r.tags) as string[])];
		if (r.aamc_code) tags.push(`AAMC::${r.aamc_code}`);
		let row: string[];
		if (kind === 'anki') {
			// Notes imported from Anki are already HTML; their first two fields go in the two columns.
			const values = Object.values(fields);
			row = [r.guid, typeNames.get(r.note_type_id) ?? 'Basic', values[0] ?? '', values[1] ?? '', tags.join(' ')];
		} else {
			const names = NOTE_KINDS.find((k) => k.kind === kind)!.fields;
			row = [r.guid, ankiName[kind], mdToHtml(fields[names[0]] ?? ''), mdToHtml(fields[names[1]] ?? ''), tags.join(' ')];
		}
		lines.push(row.map(csvCell).join(','));
	}
	return lines.join('\r\n') + '\r\n';
}

function annotationsMarkdown(conn: Database.Database) {
	const rows = conn
		.prepare(
			`SELECT a.body, a.updated_at, d.title, an.page_number, an.exact, an.section_title
			 FROM annotation a LEFT JOIN document d ON d.id = a.document_id LEFT JOIN anchor an ON an.id = a.anchor_id
			 WHERE a.deleted_at IS NULL ORDER BY d.title, an.page_number, a.created_at`
		)
		.all() as {
		body: string;
		updated_at: number;
		title: string | null;
		page_number: number | null;
		exact: string | null;
		section_title: string | null;
	}[];
	const out = ['# Reading notes', ''];
	let current: string | null = null;
	for (const r of rows) {
		const book = r.title ?? 'Notes without a book';
		if (book !== current) {
			out.push(`## ${book}`, '');
			current = book;
		}
		const where = [r.section_title, r.page_number ? `p. ${r.page_number}` : null].filter(Boolean).join(' · ');
		if (where) out.push(`**${where}**`, '');
		if (r.exact) out.push(...r.exact.split('\n').map((l) => `> ${l}`), '');
		out.push(r.body, '', `_Updated ${new Date(r.updated_at).toISOString().slice(0, 10)}_`, '', '---', '');
	}
	return out.join('\n');
}

export async function buildExport() {
	fs.mkdirSync(config.paths.tmp, { recursive: true });
	const tmpDb = path.join(config.paths.tmp, `export-${uuidv7()}.sqlite`);
	await sqlite().backup(tmpDb);
	finalizeBackupFile(tmpDb);
	const facts = inspectDatabase(tmpDb);
	// AI API keys stay out of exports (they're for this installation, and exports get shared or stored elsewhere).
	const writable = new Database(tmpDb);
	try {
		if (writable.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_provider'").get()) {
			writable.prepare('UPDATE ai_provider SET api_key = NULL').run();
		}
	} finally {
		writable.close();
	}
	const conn = new Database(tmpDb, { readonly: true });
	const zip = new yazl.ZipFile();
	const counts: Record<string, number> = {};
	try {
		for (const table of JSON_TABLES) {
			const rows = conn.prepare(`SELECT * FROM ${table}`).all();
			counts[table] = rows.length;
			zip.addBuffer(Buffer.from(JSON.stringify(rows, null, 1)), `tables/${table}.json`);
		}
		const u = conn
			.prepare(
				`SELECT display_name, test_date, goal_score, weekly_hours, study_days, day_start_hour, time_zone,
				        new_cards_per_day, desired_retention, baseline, created_at FROM user WHERE id = 1`
			)
			.get();
		zip.addBuffer(Buffer.from(JSON.stringify(u ?? null, null, 1)), 'tables/user-settings.json');
		zip.addBuffer(Buffer.from(cardsCsv(conn)), 'cards.csv');
		zip.addBuffer(Buffer.from(annotationsMarkdown(conn)), 'annotations.md');
	} finally {
		conn.close();
	}
	const missing: string[] = [];
	for (const f of facts.files) {
		if (storedFileExists(f.hash, f.ext)) {
			zip.addFile(storedFilePath(f.hash, f.ext), `files/${f.hash}.${f.ext}`, { compress: false });
		} else {
			missing.push(f.hash);
		}
	}
	zip.addFile(tmpDb, 'database.sqlite', { compress: true });
	const manifest = {
		format: EXPORT_FORMAT,
		formatVersion: EXPORT_FORMAT_VERSION,
		appVersion: config.version,
		exportedAt: new Date().toISOString(),
		installationId: facts.installationId,
		schemaTag: facts.schemaTag,
		files: facts.files.length,
		missingFiles: missing,
		counts
	};
	zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
	zip.addBuffer(
		Buffer.from(
			[
				'Medicus Vitae full export',
				'',
				'database.sqlite  Everything in the app. Restore it with Settings > Data > Restore from export,',
				'                 or choose "Restore from an export" when setting up a new installation.',
				'files/           The original books, and images and audio from Anki decks, named by their SHA-256 hash.',
				'tables/          Readable JSON copies of your data.',
				'cards.csv        Your cards for Anki: File > Import, Comma separated, HTML enabled.',
				'                 Cards that came from Anki keep their first two fields here; the full notes',
				'                 (every field, note type and media file) are in database.sqlite.',
				'annotations.md   Your reading notes as Markdown.',
				'',
				'AI API keys are not included. Add them again under Settings > AI after restoring.',
				''
			].join('\r\n')
		),
		'README.txt'
	);
	zip.end();
	let cleaned = false;
	const cleanup = () => {
		if (cleaned) return;
		cleaned = true;
		setTimeout(() => removeDbFile(tmpDb), 1000);
	};
	zip.outputStream.on('end', cleanup);
	zip.outputStream.on('error', cleanup);
	zip.outputStream.on('close', cleanup);
	const date = new Date().toISOString().slice(0, 10);
	return { stream: zip.outputStream, filename: `medicus-vitae-export-${date}.zip`, cleanup };
}

// ------------------------------------------------------------- restore

export class RestoreError extends Error {}

function openZip(file: string): Promise<yauzl.ZipFile> {
	return new Promise((resolve, reject) =>
		yauzl.open(file, { lazyEntries: true, autoClose: false }, (err, zip) => (err || !zip ? reject(err) : resolve(zip)))
	);
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
	return new Promise((resolve, reject) =>
		zip.openReadStream(entry, (err, stream) => (err || !stream ? reject(err) : resolve(stream)))
	);
}

/**
 * Becomes the primary of the restored installation, with a generation above both
 * the restored copy's and the one it replaced, so any older copy elsewhere steps down.
 */
function claimPrimary(previous: { hostId: string | null; writeSeq: number; generation: number }, replacedGeneration: number) {
	const conn = sqlite();
	const now = Date.now();
	conn
		.prepare('UPDATE instance SET generation = ?, primary_host_id = ?, promoted_at = ?, promoted_from = ? WHERE id = 1')
		.run(
			Math.max(previous.generation, replacedGeneration) + 1,
			hostId(),
			now,
			JSON.stringify({ hostId: previous.hostId ?? 'unknown', snapshotId: null, writeSeq: previous.writeSeq, generation: previous.generation })
		);
	setRole('primary');
}

function currentGeneration(): number {
	try {
		const r = sqlite().prepare('SELECT generation FROM instance WHERE id = 1').get() as { generation: number } | undefined;
		return r?.generation ?? 0;
	} catch {
		return 0;
	}
}

async function replaceWith(dbFile: string, label: string) {
	if (!integrityOk(dbFile)) throw new RestoreError('That database copy failed its integrity check.');
	const facts = inspectDatabase(dbFile);
	if (!facts.installationId) throw new RestoreError('That file is not a Medicus Vitae (or Cortex) database.');
	const replacedGeneration = currentGeneration();
	// Keep a copy of what is being replaced.
	const keepAs = path.join(config.paths.keptAside, `cortex-before-${label}-${Date.now()}.sqlite`);
	fs.mkdirSync(config.paths.keptAside, { recursive: true });
	try {
		await createSnapshot('pre-restore');
	} catch {
		// An empty or broken current database can't be snapshotted; it is still kept aside below.
	}
	await swapMainDatabase(dbFile, keepAs, { beforeMigrate: preUpgradeSnapshot });
	clearSchedulerCache();
	return { ...facts, replacedGeneration };
}

/** Restores a full export into this installation (replaces the current data, which is kept aside). */
export async function restoreFromExport(zipPath: string) {
	const zip = await openZip(zipPath);
	const tmpDir = path.join(config.paths.tmp, `restore-${uuidv7()}`);
	fs.mkdirSync(tmpDir, { recursive: true });
	let manifest: { format?: string; formatVersion?: number } | null = null;
	let dbFile: string | null = null;
	let filesRestored = 0;
	try {
		await new Promise<void>((resolve, reject) => {
			zip.on('error', reject);
			zip.on('end', () => resolve());
			zip.on('entry', async (entry: yauzl.Entry) => {
				try {
					const name = entry.fileName;
					if (name === 'manifest.json') {
						const chunks: Buffer[] = [];
						for await (const c of await entryStream(zip, entry)) chunks.push(c as Buffer);
						manifest = JSON.parse(Buffer.concat(chunks).toString('utf8'));
					} else if (name === 'database.sqlite') {
						dbFile = path.join(tmpDir, 'database.sqlite');
						await pipeline(await entryStream(zip, entry), fs.createWriteStream(dbFile));
					} else {
						const m = /^files\/([a-f0-9]{64})\.([a-z0-9]+)$/.exec(name);
						if (m) {
							const [, hash, ext] = m;
							if (!storedFileExists(hash, ext)) {
								const tmp = path.join(tmpDir, `${hash}.${ext}`);
								const hasher = createHash('sha256');
								const src = await entryStream(zip, entry);
								src.on('data', (c: Buffer) => hasher.update(c));
								await pipeline(src, fs.createWriteStream(tmp));
								if (hasher.digest('hex') !== hash) throw new RestoreError(`A book file in the export is damaged (${hash.slice(0, 8)}…).`);
								commitTmpFile(tmp, hash, ext);
							}
							filesRestored++;
						}
					}
					zip.readEntry();
				} catch (err) {
					reject(err);
				}
			});
			zip.readEntry();
		});
	} finally {
		zip.close();
	}
	try {
		const mf = manifest as { format?: string; formatVersion?: number } | null;
		if (!mf || mf.format !== EXPORT_FORMAT) throw new RestoreError('That zip is not a Medicus Vitae (or Cortex) export.');
		if ((mf.formatVersion ?? 0) > EXPORT_FORMAT_VERSION) {
			throw new RestoreError('That export was made by a newer version of Medicus Vitae. Update this installation first.');
		}
		if (!dbFile) throw new RestoreError('The export has no database in it.');
		const facts = await replaceWith(dbFile, 'restore');
		claimPrimary(
			{ hostId: facts.primaryHostId, writeSeq: facts.writeSeq, generation: facts.generation },
			facts.replacedGeneration
		);
		return { filesRestored };
	} finally {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	}
}

/** Restores one of this device's own snapshots. */
export async function restoreSnapshot(meta: SnapshotMeta) {
	const tmp = path.join(config.paths.tmp, `snapshot-${uuidv7()}.sqlite`);
	try {
		await gunzipFile(snapshotDbPath(meta), tmp);
		const facts = await replaceWith(tmp, 'snapshot');
		claimPrimary(
			{ hostId: facts.primaryHostId, writeSeq: facts.writeSeq, generation: facts.generation },
			facts.replacedGeneration
		);
	} finally {
		removeDbFile(tmp);
	}
}
