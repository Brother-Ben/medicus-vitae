// Checks a download made by scripts/package.mjs, with the Node.js inside it:
//   node scripts/smoke-test.mjs dist/Medicus-Vitae-<version>-windows-x64.zip
//   node scripts/smoke-test.mjs dist/Medicus-Vitae-<version>-mac-arm64.dmg
// The download is unpacked into a temporary folder first, as a user would, outside this
// repository, so a library missing from the package can't be borrowed from the
// repository's own node_modules. (A package folder works too, without that guarantee.)
// 1. The pieces a user needs are there (the tray app or the Mac app's launcher, the guides).
// 2. Every native library loads on this system (database, vector search, passwords,
//    the local search model, image decoding).
// 3. The server starts with an empty data folder, answers /api/health, and sends a new
//    visitor to account setup (so a fresh installation has no account in it).
// Uses its own port and temporary folders, so a copy of Medicus that is already running
// isn't touched.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

function fail(message) {
	console.error(`FAIL: ${message}`);
	process.exit(1);
}
function run(file, argv) {
	const r = spawnSync(file, argv, { stdio: 'inherit' });
	if (r.status !== 0) fail(`${path.basename(file)} ${argv.join(' ')} failed`);
}
function need(file, what) {
	if (!fs.existsSync(file)) fail(`missing ${what}: ${file}`);
}

let target = path.resolve(process.argv[2] ?? 'dist');
need(target, 'the download');
// A folder such as dist/: the one download in it.
if (fs.statSync(target).isDirectory() && !fs.existsSync(path.join(target, 'server', 'index.js'))) {
	const found = fs.readdirSync(target).filter((f) => /\.(zip|dmg)$/i.test(f));
	if (found.length !== 1) fail(`expected one .zip or .dmg in ${target}, found ${found.length}`);
	target = path.join(target, found[0]);
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'medicus-smoke-'));
let appDir = target;

if (/\.zip$/i.test(target)) {
	console.log(`== Unzipping ${path.basename(target)}`);
	// Windows' own tar reads zip files (Git Bash's tar doesn't).
	const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
	run(tar, ['-xf', target, '-C', tmp]);
	appDir = path.join(tmp, 'Medicus Vitae');
} else if (/\.dmg$/i.test(target)) {
	console.log(`== Opening ${path.basename(target)}`);
	const mnt = path.join(tmp, 'mnt');
	fs.mkdirSync(mnt);
	run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mnt, target]);
	try {
		need(path.join(mnt, 'Read me first.txt'), 'the install guide');
		if (fs.readlinkSync(path.join(mnt, 'Applications')) !== '/Applications') fail('the Applications shortcut is wrong');
		run('ditto', [path.join(mnt, 'Medicus Vitae.app'), path.join(tmp, 'Medicus Vitae.app')]);
	} finally {
		spawnSync('hdiutil', ['detach', mnt, '-force'], { stdio: 'inherit' });
	}
	appDir = path.join(tmp, 'Medicus Vitae.app', 'Contents', 'Resources', 'app');
}

const nodeBin = path.join(appDir, 'runtime', 'node', ...(process.platform === 'win32' ? ['node.exe'] : []));
need(path.join(appDir, 'server', 'index.js'), 'the server');
need(nodeBin, 'Node.js');
need(path.join(appDir, 'build', 'handler.js'), 'the build');
if (process.platform === 'win32') {
	for (const f of ['Medicus Vitae.exe', 'Add shortcuts.cmd', 'README.txt', 'LICENSE.txt', path.join('desktop', 'add-shortcuts.ps1')]) need(path.join(appDir, f), 'a file');
} else {
	const contents = path.resolve(appDir, '..', '..');
	const launcher = path.join(contents, 'MacOS', 'Medicus Vitae');
	need(launcher, "the app's launcher");
	if (!(fs.statSync(launcher).mode & 0o111)) fail('the launcher is not executable');
	if (!(fs.statSync(nodeBin).mode & 0o111)) fail('Node.js is not executable');
	need(path.join(contents, 'Info.plist'), 'Info.plist');
	need(path.join(contents, 'Resources', 'medicus.icns'), 'the app icon');
	run('plutil', ['-lint', path.join(contents, 'Info.plist')]);
	run('/bin/bash', ['-n', launcher]);
}
console.log('package contents ok');

console.log('\n== Native libraries');
const check = `
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import argon2 from 'argon2';
const db = new Database(':memory:');
sqliteVec.load(db);
console.log('sqlite', db.prepare('select sqlite_version() v').get().v, '/ sqlite-vec', db.prepare('select vec_version() v').get().v);
const hash = await argon2.hash('correct horse battery');
if (!(await argon2.verify(hash, 'correct horse battery'))) throw new Error('argon2 verify failed');
console.log('argon2 ok');
const ort = await import('onnxruntime-node');
if (typeof ort.InferenceSession?.create !== 'function') throw new Error('onnxruntime-node did not load');
console.log('onnxruntime-node ok');
const sharp = (await import('sharp')).default;
const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#0f766e' } }).png().toBuffer();
console.log('sharp ok,', png.length, 'byte test image');
await import('@huggingface/transformers');
console.log('transformers ok');
`;
const r = spawnSync(nodeBin, ['--input-type=module', '-e', check], { cwd: appDir, stdio: 'inherit' });
if (r.status !== 0) fail('a native library did not load');

console.log('\n== Server with an empty data folder');
const port = await new Promise((resolve) => {
	const s = net.createServer().listen(0, '127.0.0.1', () => {
		const p = s.address().port;
		s.close(() => resolve(p));
	});
});
const server = spawn(nodeBin, [path.join(appDir, 'server', 'index.js')], {
	cwd: appDir,
	env: {
		...process.env,
		PORT: String(port),
		HOST: '127.0.0.1',
		CORTEX_ENV_LOADED: '1',
		CORTEX_DATA_DIR: path.join(tmp, 'data'),
		CORTEX_EXTENSION_DIR: path.join(tmp, 'browser-extension'),
		CORTEX_EMBEDDINGS: 'off'
	},
	stdio: ['ignore', 'pipe', 'pipe']
});
let output = '';
server.stdout.on('data', (d) => (output += d));
server.stderr.on('data', (d) => (output += d));

async function stop() {
	if (server.exitCode === null) {
		server.kill();
		await new Promise((resolve) => server.once('exit', resolve));
	}
	try {
		fs.rmSync(tmp, { recursive: true, force: true });
	} catch {
		// the OS cleans its temp folder
	}
}

try {
	const base = `http://127.0.0.1:${port}`;
	let health = null;
	for (let i = 0; i < 120 && server.exitCode === null; i++) {
		try {
			const res = await fetch(`${base}/api/health`);
			if (res.ok) {
				health = await res.json();
				break;
			}
		} catch {
			// not listening yet
		}
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	if (!health) throw new Error(`the server did not answer /api/health\n${output}`);
	console.log('health:', JSON.stringify(health));
	if (health.app !== 'medicus-vitae') throw new Error('unexpected /api/health answer');

	const home = await fetch(`${base}/`, { redirect: 'manual' });
	const location = home.headers.get('location') ?? '';
	console.log(`GET / -> ${home.status} ${location}`);
	if (!(home.status >= 300 && home.status < 400 && location.includes('/setup'))) {
		throw new Error('a new installation should send visitors to account setup');
	}
	const setup = await fetch(`${base}/setup`);
	const html = await setup.text();
	console.log(`GET /setup -> ${setup.status}`);
	if (!setup.ok || !html.includes('Medicus')) throw new Error('the setup page did not load');

	const ext = path.join(tmp, 'browser-extension', 'manifest.json');
	for (let i = 0; i < 20 && !fs.existsSync(ext); i++) await new Promise((resolve) => setTimeout(resolve, 250));
	if (!fs.existsSync(ext)) throw new Error('the browser extension was not copied to its folder');
	console.log('browser extension copied');
} catch (err) {
	await stop();
	fail(err.message);
}
await stop();
console.log('\nPASS');
