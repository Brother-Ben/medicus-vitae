import { eq } from 'drizzle-orm';
import { clearTwoFactor, purgeExpiredSessions } from './auth';
import { config, ensureDataDirs } from './config';
import { closeDatabases, db, openLocalDatabase, openMainDatabase } from './db';
import { job } from './db/schema';
import './extract';
import './ai/generate';
import { activeImportDirs } from './anki/importer';
import { autoSync } from './anki/sync';
import { closeIndexDb } from './ai/index-db';
import { extensionDir } from './browser-extension';
import { indexTick, requestIndex, stopIndexer } from './ai/indexer';
import { enableTestAi } from './ai/providers';
import { cleanTmp } from './files';
import { ensureInstance, hostId, isPrimary, role } from './instance';
import { kickJobs, recoverJobs, stopJobs } from './jobs';
import { checkPeer, peerConfig } from './peer';
import { preUpgradeSnapshot, pruneSnapshots, scheduledSnapshots } from './snapshots';

// Starts the app once per process: data folders, databases (with a snapshot
// before any migration of existing data), background jobs, hourly/daily
// snapshots and, if another device is set up, the standby/primary check.

declare global {
	// Set by server/index.js (the production entry) so the app can ask it to exit.
	var __cortexServer: { requestExit(code: number, reason: string): void } | undefined;
	// Read by server/index.js to close the databases cleanly before exiting.
	var __cortex: { shutdown(reason: string): Promise<void> } | undefined;
}

let starting: Promise<void> | null = null;
let timer: NodeJS.Timeout | null = null;
let minutes = 0;

export function startApp(): Promise<void> {
	starting ??= start().catch((err) => {
		starting = null;
		throw err;
	});
	return starting;
}

async function start() {
	ensureDataDirs();
	openLocalDatabase();
	hostId();
	await openMainDatabase({ beforeMigrate: async (conn) => preUpgradeSnapshot(conn) });
	ensureInstance();
	purgeExpiredSessions();
	// A standby gets this from its primary's next snapshot.
	if (isPrimary()) {
		try {
			clearTwoFactor();
		} catch (err) {
			console.error('Couldn’t clear the old two-factor settings:', err);
		}
	}

	// Upload leftovers older than six hours, except ones a queued import still needs.
	const pendingTmp = new Set(
		db()
			.select()
			.from(job)
			.where(eq(job.status, 'queued'))
			.all()
			.map((j) => String(j.payload.tmpPath ?? ''))
			.filter(Boolean)
	);
	// Anki packages waiting for the owner's go-ahead are kept too.
	for (const dir of activeImportDirs()) pendingTmp.add(dir);
	cleanTmp(6 * 3_600_000, pendingTmp);
	recoverJobs();
	kickJobs();
	try {
		pruneSnapshots();
	} catch (err) {
		console.error('Snapshot cleanup failed:', err);
	}
	// The browser extension's copy outside the app folder gets this version's files,
	// so reloading it in brave://extensions after an update picks them up.
	extensionDir();

	timer = setInterval(() => void tick(), 60_000);
	setTimeout(() => void tick(), 10_000).unref();
	if (peerConfig()) setTimeout(() => void checkPeer().catch(() => {}), 3_000).unref();
	// The tutor's search index is per device and derived: bring it up to date in the background.
	setTimeout(() => requestIndex(), 5_000).unref();
	if (process.env.CORTEX_FAKE_AI === '1') {
		const { fakeComplete, fakeResearch } = await import('./ai/fake');
		enableTestAi(fakeComplete, fakeResearch);
		console.warn('CORTEX_FAKE_AI=1: using the stand-in AI service for tests.');
	}

	globalThis.__cortex = { shutdown };
	console.log(`Medicus Vitae ${config.version} ready · data in ${config.dataDir} · this device is ${role()}`);
}

async function tick() {
	minutes++;
	try {
		await scheduledSnapshots();
	} catch (err) {
		console.error('Scheduled snapshot failed:', err);
	}
	if (peerConfig() && minutes % Math.max(1, config.peerPollMinutes) === 0) {
		await checkPeer().catch((err) => console.error('Peer check failed:', err));
	}
	if (minutes % 2 === 0) indexTick();
	// Anki sync on its own schedule, only once it has been set up and while Anki is open.
	void autoSync().catch((err) => console.error('Anki auto-sync failed:', err));
	if (minutes % 60 === 0) {
		try {
			purgeExpiredSessions();
		} catch {
			// ignore
		}
	}
}

let stopping: Promise<void> | null = null;

export function shutdown(reason: string): Promise<void> {
	stopping ??= (async () => {
		console.log(`Medicus Vitae stopping (${reason})`);
		if (timer) clearInterval(timer);
		timer = null;
		await stopIndexer();
		await stopJobs();
		closeIndexDb();
		closeDatabases();
	})();
	return stopping;
}

/** The Quit button: hand off to the production server so it closes connections, or exit directly in dev. */
export function requestQuit() {
	setTimeout(() => {
		if (globalThis.__cortexServer) {
			globalThis.__cortexServer.requestExit(0, 'quit');
		} else {
			void shutdown('quit').finally(() => process.exit(0));
		}
	}, 250);
}
