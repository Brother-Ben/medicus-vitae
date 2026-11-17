// Runs in a worker thread (started by src/lib/server/extract.ts). Parses one PDF
// with PDF.js and posts its outline and per-page text back to the main thread,
// which owns all database writes. Kept off the main thread so a large book never
// stalls the web server.

import { parentPort, workerData } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { buildPageText, PAGE_TEXT_VERSION } from '../src/lib/pdf/pagetext.js';

const require = createRequire(import.meta.url);

/** @param {object} msg */
const post = (msg) => parentPort?.postMessage(msg);

async function main() {
	const { filePath } = workerData;
	const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
	const pdfjs = await import(pathToFileURL(path.join(pdfjsRoot, 'legacy', 'build', 'pdf.mjs')).href);

	const data = new Uint8Array(await readFile(filePath));
	// PDF.js wants these folder paths to end in a forward slash, on Windows too.
	const folder = (name) => path.join(pdfjsRoot, name).replace(/\\/g, '/') + '/';
	const loadingTask = pdfjs.getDocument({
		data,
		isEvalSupported: false,
		disableFontFace: true,
		useSystemFonts: false,
		standardFontDataUrl: folder('standard_fonts'),
		cMapUrl: folder('cmaps'),
		cMapPacked: true,
		verbosity: 0
	});

	let doc;
	try {
		doc = await loadingTask.promise;
	} catch (err) {
		if (err && err.name === 'PasswordException') {
			throw new Error('This PDF is password-protected. Remove the password and import it again.');
		}
		if (err && err.name === 'InvalidPDFException') {
			throw new Error('This file is not a valid PDF.');
		}
		throw err;
	}

	let title = '';
	try {
		const meta = await doc.getMetadata();
		title = (meta?.info?.Title ?? '').toString().trim();
	} catch {
		// Metadata is optional.
	}
	post({ type: 'meta', numPages: doc.numPages, title, extractor: `pdfjs-${pdfjs.version}/pagetext-${PAGE_TEXT_VERSION}` });

	/** @type {{ title: string, level: number, page: number }[]} */
	const outline = [];
	try {
		const tree = await doc.getOutline();
		/** @param {any[]} nodes @param {number} level */
		const walk = async (nodes, level) => {
			for (const node of nodes ?? []) {
				let page = null;
				try {
					const dest = typeof node.dest === 'string' ? await doc.getDestination(node.dest) : node.dest;
					if (Array.isArray(dest) && dest[0]) {
						page =
							typeof dest[0] === 'number' ? dest[0] + 1 : (await doc.getPageIndex(dest[0])) + 1;
					}
				} catch {
					page = null;
				}
				const titleText = String(node.title ?? '').replace(/\s+/g, ' ').trim();
				if (page && titleText) outline.push({ title: titleText, level, page });
				if (level < 2 && node.items?.length) await walk(node.items, level + 1);
			}
		};
		await walk(tree ?? [], 0);
	} catch {
		// A broken outline shouldn't stop the import.
	}
	post({ type: 'outline', items: outline });

	let textChars = 0;
	for (let n = 1; n <= doc.numPages; n++) {
		const page = await doc.getPage(n);
		const viewport = page.getViewport({ scale: 1 });
		const content = await page.getTextContent();
		const { text, runs } = buildPageText(content.items, viewport, content.styles);
		textChars += text.trim().length;
		post({ type: 'page', page: n, width: viewport.width, height: viewport.height, text, runs });
		page.cleanup();
	}

	post({ type: 'done', numPages: doc.numPages, textChars });
	await loadingTask.destroy();
}

main().catch((err) => {
	post({ type: 'error', message: err instanceof Error ? err.message : String(err) });
});
