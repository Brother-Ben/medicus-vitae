// Builds into build-next/ instead of build/, so the app can keep running while a
// new version is built. server/index.js switches to it the next time it starts.
//   npm run build:next
//   npm run build:next -- --test   (for test runs only: the app won't switch to it)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'build-next');
fs.rmSync(out, { recursive: true, force: true });
const assets = spawnSync(process.execPath, [path.join(root, 'scripts', 'copy-assets.mjs')], { cwd: root, stdio: 'inherit' });
if (assets.status) process.exit(assets.status);
const vite = path.join(root, 'node_modules', 'vite', 'bin', 'vite.js');
const r = spawnSync(process.execPath, [vite, 'build'], { cwd: root, stdio: 'inherit', env: { ...process.env, CORTEX_BUILD_OUT: 'build-next' } });
if (r.status) process.exit(r.status);
if (process.argv.includes('--test')) {
	console.log('Built build-next/ for testing (CORTEX_BUILD_DIR=build-next). The app won’t switch to it.');
} else {
	fs.writeFileSync(path.join(out, '.ready'), new Date().toISOString());
	console.log('Built build-next/. It is used the next time the app starts.');
}
