// Installs dependencies exactly as package-lock.json lists them (npm ci), working around
// an npm mistake: on a clean install npm decides from the lock file alone whether a package
// needs compiling, and the lock file doesn't record better-sqlite3's "gypfile": false. So npm
// tries to compile better-sqlite3 from source (node-gyp, which needs Visual Studio or
// Xcode) although the package ships ready-made binaries for every system. Here: install with
// scripts off, then run the install scripts of just the packages the lock file says have one.
//
//   node scripts/install-deps.mjs              # development: everything, then svelte-kit sync
//   node scripts/install-deps.mjs --omit=dev   # production only (scripts/package.mjs, Docker)
// Run it in the folder that holds package.json and package-lock.json.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const omitDev = process.argv.includes('--omit=dev');
const cwd = process.cwd();
const npmCli = [
	path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
	path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
].find((p) => fs.existsSync(p));

function npm(args) {
	const r = npmCli
		? spawnSync(process.execPath, [npmCli, ...args], { cwd, stdio: 'inherit' })
		: spawnSync('npm', args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' });
	if (r.error) throw r.error;
	if (r.status !== 0) process.exit(r.status ?? 1);
}

npm(['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error', ...(omitDev ? ['--omit=dev'] : [])]);

const lock = JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'));
const names = new Set();
for (const [where, entry] of Object.entries(lock.packages ?? {})) {
	if (!where || !entry.hasInstallScript) continue;
	if (omitDev && entry.dev) continue;
	if (!fs.existsSync(path.join(cwd, where, 'package.json'))) continue; // optional, for another system
	names.add(where.slice(where.lastIndexOf('node_modules/') + 'node_modules/'.length));
}
if (names.size) {
	console.log(`Running install scripts for: ${[...names].join(', ')}`);
	npm(['rebuild', '--loglevel=error', ...names]);
}
if (!omitDev && lock.packages?.['']?.devDependencies?.['@sveltejs/kit']) npm(['run', 'prepare']);
console.log('Dependencies installed.');
