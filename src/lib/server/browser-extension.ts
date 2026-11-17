// The Brave/Chrome extension's folder, for "Load unpacked".
//
// Brave remembers an unpacked extension by the folder it was loaded from and, the
// next time it starts, drops it without a word if that folder is gone. The
// extension ships inside the app folder, so moving or renaming the Medicus folder
// took the extension with it (2026-11-14: "MCAT program build" became "Medicus").
// So Medicus keeps a copy in a folder of its own that doesn't move with the app
// (%LOCALAPPDATA%\Medicus Vitae\browser-extension on Windows), brings it up to date
// whenever it starts, and the setup steps point there.

import fs from 'node:fs';
import path from 'node:path';
import { appRoot } from './config.js';

const NOTE = 'README.txt';
const NOTE_TEXT = `This folder is the Medicus Vitae browser extension (Jack Westin CARS import).

Brave loads it from here, so leave it where it is: if this folder is moved or
deleted, Brave drops the extension the next time it starts. Medicus Vitae puts
the newest version here each time it starts; after updating Medicus, press the
reload arrow on the extension's card in brave://extensions.

To set the extension up again, open Flashcards > CARS in Medicus Vitae and
follow "Set up the Medicus extension".
`;

/** The extension as it ships, inside the app folder. */
export function bundledExtensionDir(): string | null {
	const dir = path.join(appRoot(), 'browser-extension');
	return fs.existsSync(path.join(dir, 'manifest.json')) ? dir : null;
}

/** A folder that stays put when the app folder moves, or null where there's none (Docker, Mac, Linux). */
export function stableExtensionDir(): string | null {
	if (process.env.CORTEX_EXTENSION_DIR) return path.resolve(process.env.CORTEX_EXTENSION_DIR);
	if (process.platform === 'win32' && process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'Medicus Vitae', 'browser-extension');
	return null;
}

/** Makes `to` hold exactly what `from` holds (plus the note), writing only files that differ. */
export function mirrorExtension(from: string, to: string, top = true): void {
	// Only ever into a new folder or one this made (it has the note): never clear out someone's other files.
	if (top && fs.existsSync(to) && fs.readdirSync(to).length && !fs.existsSync(path.join(to, NOTE))) {
		throw new Error(`${to} already holds other files`);
	}
	fs.mkdirSync(to, { recursive: true });
	const keep = new Set<string>(top ? [NOTE] : []);
	for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
		const src = path.join(from, entry.name);
		const dest = path.join(to, entry.name);
		if (entry.isDirectory()) {
			keep.add(entry.name);
			mirrorExtension(src, dest, false);
		} else if (entry.isFile()) {
			keep.add(entry.name);
			const buf = fs.readFileSync(src);
			let same = false;
			try {
				same = fs.readFileSync(dest).equals(buf);
			} catch {
				// not there yet
			}
			if (!same) fs.writeFileSync(dest, buf);
		}
	}
	for (const entry of fs.readdirSync(to, { withFileTypes: true })) {
		if (!keep.has(entry.name)) fs.rmSync(path.join(to, entry.name), { recursive: true, force: true });
	}
	if (top) {
		const note = path.join(to, NOTE);
		let current = '';
		try {
			current = fs.readFileSync(note, 'utf8');
		} catch {
			// not there yet
		}
		if (current !== NOTE_TEXT) fs.writeFileSync(note, NOTE_TEXT);
	}
}

/**
 * The folder to choose in brave://extensions › Load unpacked: the stable copy,
 * brought up to date, or the one in the app folder if there's no stable place
 * or it can't be written. Null if the app has no extension folder.
 */
export function extensionDir(): string | null {
	const bundled = bundledExtensionDir();
	if (!bundled) return null;
	const stable = stableExtensionDir();
	if (!stable || path.resolve(stable) === path.resolve(bundled)) return bundled;
	try {
		mirrorExtension(bundled, stable);
		return stable;
	} catch (err) {
		console.warn(`Could not copy the browser extension to ${stable}; using ${bundled}:`, err);
		return bundled;
	}
}
