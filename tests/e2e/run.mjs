// Runs the end-to-end tests against the built app (`npm run build` first):
//   npm run test:e2e
// Uses throwaway data folders under tests/.tmp, never your real data. The browser
// tests drive Microsoft Edge (installed with Windows) through playwright-core.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tmp = path.join(root, 'tests', '.tmp');
fs.rmSync(tmp, { recursive: true, force: true });
fs.mkdirSync(tmp, { recursive: true });
const port = 8299;
const base = `http://127.0.0.1:${port}`;

// CORTEX_FAKE_AI: a stand-in AI service so the tutor can be tested without an account.
// CORTEX_EMBEDDINGS=off: keyword search only, so no model download during tests.
const server = spawn(process.execPath, [path.join(root, 'server', 'index.js')], {
	cwd: root,
	env: {
		...process.env,
		PORT: String(port),
		CORTEX_DATA_DIR: path.join(tmp, 'data'),
		// The browser extension's copy outside the app folder goes here, not into your own.
		CORTEX_EXTENSION_DIR: path.join(tmp, 'browser-extension'),
		CORTEX_ENV_LOADED: '1',
		CORTEX_FAKE_AI: '1',
		CORTEX_EMBEDDINGS: 'off'
	},
	stdio: 'inherit'
});

const run = (file, args) => spawnSync(process.execPath, [path.join(root, 'tests', 'e2e', file), ...args], { stdio: 'inherit' }).status;

let failed = 0;
failed += run('browser-part1.mjs', [base, root, path.join(tmp, 'screens')]) ? 1 : 0;
failed += run('browser-part3.mjs', [base, root, path.join(tmp, 'screens')]) ? 1 : 0;
failed += run('browser-part2.mjs', [base, root, path.join(tmp, 'screens')]) ? 1 : 0;
if (server.exitCode === null) server.kill();
failed += run('switch-over.mjs', [root, tmp]) ? 1 : 0;
// The Jack Westin browser extension, on stand-in pages (no server needed).
failed += run('extension.mjs', [root]) ? 1 : 0;

console.log(failed ? `\n${failed} end-to-end suite(s) failed. Screenshots: ${path.join(tmp, 'screens')}` : '\nAll end-to-end suites passed.');
process.exit(failed ? 1 : 0);
