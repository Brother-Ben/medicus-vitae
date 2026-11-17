// Production entry: `node server/index.js` (after `npm run build`).
//
// Wraps SvelteKit's adapter-node handler so that:
//  - only one Cortex runs per data folder (a lock held for the life of the process),
//  - the port is claimed before the app loads, with a clear exit code if it's taken,
//  - form posts work both over plain http://localhost and behind Tailscale Serve (HTTPS),
//  - large book uploads aren't cut off,
//  - Quit (web UI), Ctrl+C, docker stop, or the tray app closing all shut down cleanly.
//
// Exit codes: 0 normal, 1 error, 3 port in use, 4 already running on this data folder.

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(appRoot);
process.env.CORTEX_APP_ROOT ??= appRoot;

// CORTEX_ENV_FILE: the Mac app keeps its settings outside the app (in Application Support).
const envFile = process.env.CORTEX_ENV_FILE ? path.resolve(process.env.CORTEX_ENV_FILE) : path.join(appRoot, '.env');
if (!process.env.CORTEX_ENV_LOADED && fs.existsSync(envFile)) {
	process.loadEnvFile(envFile);
	process.env.CORTEX_ENV_LOADED = '1';
}

// adapter-node reads these when the handler loads.
process.env.PROTOCOL_HEADER ??= 'x-forwarded-proto';
process.env.HOST_HEADER ??= 'x-forwarded-host';
process.env.BODY_SIZE_LIMIT ??= 'Infinity';

const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8080);
const dataDir = path.resolve(appRoot, process.env.CORTEX_DATA_DIR || 'data');

function log(...args) {
	console.log(new Date().toISOString(), ...args);
}

// One Cortex per data folder: an exclusive SQLite lock, released by the OS when the process ends.
fs.mkdirSync(dataDir, { recursive: true });
let lock;
try {
	lock = new Database(path.join(dataDir, 'instance.lock'), { timeout: 0 });
	lock.pragma('locking_mode = EXCLUSIVE');
	lock.exec('BEGIN EXCLUSIVE');
} catch (err) {
	console.error(`Medicus Vitae is already running with the data folder ${dataDir}.`);
	console.error(String(err));
	process.exit(4);
}

// CORTEX_BUILD_DIR runs a particular build (the tests run build-next/ this way).
const buildDir = process.env.CORTEX_BUILD_DIR ? path.resolve(appRoot, process.env.CORTEX_BUILD_DIR) : path.join(appRoot, 'build');

// A build made while the app was running waits in build-next/ (npm run build:next);
// switch to it now, before anything from build/ is loaded.
function switchToNextBuild() {
	const next = path.join(appRoot, 'build-next');
	const current = path.join(appRoot, 'build');
	for (const name of fs.readdirSync(appRoot)) {
		if (name.startsWith('build-old-')) fs.rmSync(path.join(appRoot, name), { recursive: true, force: true });
	}
	if (!fs.existsSync(path.join(next, '.ready')) || !fs.existsSync(path.join(next, 'handler.js'))) return;
	const old = path.join(appRoot, `build-old-${Date.now()}`);
	try {
		if (fs.existsSync(current)) fs.renameSync(current, old);
		fs.renameSync(next, current);
		fs.rmSync(path.join(current, '.ready'), { force: true });
		log('Switched to the new build');
	} catch (err) {
		console.error('Could not switch to the new build, starting the current one:', err);
		if (!fs.existsSync(current) && fs.existsSync(old)) fs.renameSync(old, current);
		return;
	}
	try {
		fs.rmSync(old, { recursive: true, force: true });
	} catch {
		// removed at the next start
	}
}
if (!process.env.CORTEX_BUILD_DIR) switchToNextBuild();

if (!fs.existsSync(path.join(buildDir, 'handler.js'))) {
	console.error('The app has not been built yet. Run: npm run build');
	process.exit(1);
}

let appHandler = null;
let shuttingDown = false;

const server = http.createServer((req, res) => {
	if (!appHandler) {
		res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': '2' });
		res.end('Medicus Vitae is starting. This page will work in a moment.');
		return;
	}
	// The browser's Origin must match what SvelteKit thinks this server's origin is.
	// Behind Tailscale Serve the original scheme arrives in X-Forwarded-Proto; directly,
	// this server speaks plain HTTP.
	if (!req.headers['x-forwarded-proto']) req.headers['x-forwarded-proto'] = 'http';
	// Anki card frames have an opaque origin; they load KaTeX's stylesheet and fonts from here.
	if (req.url && req.url.startsWith('/katex/')) res.setHeader('access-control-allow-origin', '*');
	appHandler(req, res, () => {
		res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
		res.end('Not found');
	});
});

server.on('error', (err) => {
	if (err && err.code === 'EADDRINUSE') {
		console.error(`Port ${port} on ${host} is already in use. Set a different PORT in ${envFile}.`);
		process.exit(3);
	}
	console.error(err);
	process.exit(1);
});

async function shutdown(code, reason) {
	if (shuttingDown) return;
	shuttingDown = true;
	log(`Shutting down (${reason})`);
	const force = setTimeout(() => process.exit(code), 8000);
	force.unref();
	server.close();
	server.closeIdleConnections();
	setTimeout(() => server.closeAllConnections(), 2000).unref();
	try {
		await globalThis.__cortex?.shutdown(reason);
	} catch (err) {
		console.error('Error while shutting down:', err);
	}
	process.emit('sveltekit:shutdown', reason);
	try {
		lock?.close();
	} catch {
		// released on exit anyway
	}
	process.exit(code);
}

globalThis.__cortexServer = { requestExit: (code, reason) => void shutdown(code, reason) };
process.on('SIGINT', () => void shutdown(0, 'SIGINT'));
process.on('SIGTERM', () => void shutdown(0, 'SIGTERM'));

// Started by the Windows tray app: when the tray goes away (Quit, crash, sign-out) its end of
// stdin closes, and Cortex stops with it instead of lingering in the background.
if (process.env.CORTEX_WATCH_STDIN === '1') {
	process.stdin.on('end', () => void shutdown(0, 'launcher closed'));
	process.stdin.on('error', () => void shutdown(0, 'launcher closed'));
	process.stdin.resume();
}

process.on('uncaughtException', (err) => {
	console.error('Uncaught error:', err);
});
process.on('unhandledRejection', (err) => {
	console.error('Unhandled rejection:', err);
});

server.listen(port, host, async () => {
	log(`Medicus Vitae listening on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
	try {
		const mod = await import(pathToFileURL(path.join(buildDir, 'handler.js')).href);
		appHandler = mod.handler;
		log('Ready');
	} catch (err) {
		console.error('Medicus Vitae failed to start:', err);
		process.exit(1);
	}
});
