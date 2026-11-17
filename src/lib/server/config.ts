import fs from 'node:fs';
import path from 'node:path';

/** Folder that holds package.json, server/, drizzle/ and (by default) data/. */
export function appRoot(): string {
	return process.env.CORTEX_APP_ROOT ?? process.cwd();
}

// Settings live in `.env` next to the app (or come from Docker's env_file; the Mac app
// points CORTEX_ENV_FILE at Application Support). Values already in the environment win.
const envFile = process.env.CORTEX_ENV_FILE ? path.resolve(process.env.CORTEX_ENV_FILE) : path.join(appRoot(), '.env');
if (!process.env.CORTEX_ENV_LOADED && fs.existsSync(envFile)) {
	try {
		process.loadEnvFile(envFile);
	} catch (err) {
		console.warn(`Could not read ${envFile}:`, err);
	}
	process.env.CORTEX_ENV_LOADED = '1';
}

function flag(name: string, fallback: boolean): boolean {
	const v = process.env[name];
	if (v === undefined || v === '') return fallback;
	return !['0', 'false', 'no', 'off'].includes(v.toLowerCase());
}

const dataDir = path.resolve(appRoot(), process.env.CORTEX_DATA_DIR || 'data');

export const config = {
	version: typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '0.0.0',
	dataDir,
	paths: {
		mainDb: path.join(dataDir, 'cortex.sqlite'),
		localDb: path.join(dataDir, 'local.sqlite'),
		files: path.join(dataDir, 'files'),
		tmp: path.join(dataDir, 'tmp'),
		snapshots: path.join(dataDir, 'snapshots'),
		peer: path.join(dataDir, 'peer'),
		keptAside: path.join(dataDir, 'kept-aside'),
		logs: path.join(dataDir, 'logs'),
		/** Passages and their embeddings for the tutor and meaning search. Derived, per device, rebuilt as needed. */
		indexDb: path.join(dataDir, 'index.sqlite'),
		/** The local embedding model, downloaded once (or provided with CORTEX_MODELS_DIR). */
		models: path.resolve(appRoot(), process.env.CORTEX_MODELS_DIR || path.join(dataDir, 'models')),
		migrations: path.join(appRoot(), 'drizzle'),
		pdfWorker: path.join(appRoot(), 'server', 'pdf-worker.js'),
		embedWorker: path.join(appRoot(), 'server', 'embed-worker.js')
	},
	port: Number(process.env.PORT || 8080),
	host: process.env.HOST || '127.0.0.1',
	/** The web UI's Quit button. Off in Docker, where the restart policy would just start it again. */
	allowQuit: flag('CORTEX_ALLOW_QUIT', true),
	/** Shared secret the Windows tray app uses to ask the server to shut down. */
	controlToken: process.env.CORTEX_CONTROL_TOKEN || '',
	/** Set by the tray app so the UI can mention it. */
	launcher: process.env.CORTEX_LAUNCHER || '',
	snapshots: {
		enabled: flag('CORTEX_SNAPSHOTS', true),
		hourlyKeepHours: 48,
		dailyKeepDays: 30,
		manualKeep: 10,
		preUpgradeKeep: 10
	},
	/** How often a standby asks its peer for a newer snapshot. */
	peerPollMinutes: Number(process.env.CORTEX_PEER_POLL_MINUTES || 5),
	/** Local meaning search (AI-08). Set CORTEX_EMBEDDINGS=off to use keyword search only. */
	embeddings: flag('CORTEX_EMBEDDINGS', true)
};

export function ensureDataDirs() {
	for (const dir of [
		config.dataDir,
		config.paths.files,
		config.paths.tmp,
		config.paths.snapshots,
		config.paths.peer,
		config.paths.keptAside,
		config.paths.logs
	]) {
		fs.mkdirSync(dir, { recursive: true });
	}
}
