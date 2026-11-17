// The browser extension's copy outside the app folder: Brave drops an unpacked
// extension whose folder has gone, and moving or renaming the Medicus folder did
// just that, so the setup steps point at a copy that stays put.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-test-ext-'));
const app = path.join(tmp, 'app');
const stable = path.join(tmp, 'local', 'Medicus Vitae', 'browser-extension');
const saved = { root: process.env.CORTEX_APP_ROOT, dir: process.env.CORTEX_EXTENSION_DIR, local: process.env.LOCALAPPDATA };
process.env.CORTEX_APP_ROOT = app;
process.env.CORTEX_ENV_LOADED = '1';
process.env.CORTEX_EXTENSION_DIR = stable;

let ext: typeof import('./browser-extension');
const bundled = path.join(app, 'browser-extension');
const put = (dir: string, name: string, text: string) => {
	fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
	fs.writeFileSync(path.join(dir, name), text);
};
const read = (dir: string, name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

beforeAll(async () => {
	put(bundled, 'manifest.json', '{"manifest_version":3,"name":"Medicus","version":"1.0.0"}');
	put(bundled, 'content.js', 'console.log(1)');
	put(bundled, 'page-data.js', 'console.log(2)');
	put(bundled, 'icons/16.png', 'png');
	ext = await import('./browser-extension');
});

afterAll(() => {
	for (const [k, v] of [['CORTEX_APP_ROOT', saved.root], ['CORTEX_EXTENSION_DIR', saved.dir], ['LOCALAPPDATA', saved.local]] as const) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe('browser extension folder', () => {
	it('copies the extension to a folder outside the app and points setup there', () => {
		expect(ext.extensionDir()).toBe(stable);
		for (const f of ['manifest.json', 'content.js', 'page-data.js', 'icons/16.png']) expect(read(stable, f)).toBe(read(bundled, f));
		expect(read(stable, 'README.txt')).toMatch(/leave it where it is/);
	});

	it('brings the copy up to date: changed files rewritten, removed ones gone, unchanged ones left alone', () => {
		const old = new Date('2001-01-01T00:00:00Z');
		fs.utimesSync(path.join(stable, 'page-data.js'), old, old);
		put(bundled, 'manifest.json', '{"manifest_version":3,"name":"Medicus","version":"1.0.1"}');
		fs.rmSync(path.join(bundled, 'content.js'));
		put(bundled, 'background.js', 'console.log(3)');

		expect(ext.extensionDir()).toBe(stable);
		expect(read(stable, 'manifest.json')).toContain('1.0.1');
		expect(fs.existsSync(path.join(stable, 'content.js'))).toBe(false);
		expect(read(stable, 'background.js')).toBe('console.log(3)');
		expect(fs.statSync(path.join(stable, 'page-data.js')).mtime.getTime()).toBe(old.getTime());
		expect(fs.existsSync(path.join(stable, 'README.txt'))).toBe(true);
	});

	it('still works when the app folder moves: the copy keeps its place', () => {
		const moved = path.join(tmp, 'renamed-app');
		fs.renameSync(app, moved);
		process.env.CORTEX_APP_ROOT = moved;
		try {
			expect(ext.extensionDir()).toBe(stable);
			expect(read(stable, 'manifest.json')).toContain('1.0.1');
		} finally {
			fs.renameSync(moved, app);
			process.env.CORTEX_APP_ROOT = app;
		}
	});

	it('never clears out a folder it didn’t make; it falls back to the app’s own folder', () => {
		const other = path.join(tmp, 'someone-elses');
		put(other, 'notes.txt', 'keep me');
		process.env.CORTEX_EXTENSION_DIR = other;
		try {
			expect(ext.extensionDir()).toBe(bundled);
			expect(fs.readdirSync(other)).toEqual(['notes.txt']);
		} finally {
			process.env.CORTEX_EXTENSION_DIR = stable;
		}
	});

	it('uses the app’s own folder where there’s no stable place, and nothing when there’s no extension', () => {
		delete process.env.CORTEX_EXTENSION_DIR;
		process.env.LOCALAPPDATA = '';
		try {
			expect(ext.extensionDir()).toBe(bundled);
			process.env.CORTEX_APP_ROOT = path.join(tmp, 'nowhere');
			expect(ext.extensionDir()).toBeNull();
		} finally {
			process.env.CORTEX_APP_ROOT = app;
			process.env.CORTEX_EXTENSION_DIR = stable;
		}
	});
});
