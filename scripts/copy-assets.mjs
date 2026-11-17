// Copies third-party browser assets into static/ so everything works offline
// and over Tailscale without any CDN:
//  - PDF.js data files (standard fonts, CMaps, image decoders) → static/pdfjs
//  - KaTeX's stylesheet and fonts (math on cards imported from Anki) → static/katex
// Runs before `vite dev` and `vite build` (see package.json).

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));

const pdfjsRoot = path.dirname(require.resolve('pdfjs-dist/package.json'));
const pdfTarget = path.join(root, 'static', 'pdfjs');
for (const dir of ['standard_fonts', 'cmaps', 'wasm']) {
	const from = path.join(pdfjsRoot, dir);
	if (!fs.existsSync(from)) continue;
	fs.rmSync(path.join(pdfTarget, dir), { recursive: true, force: true });
	fs.cpSync(from, path.join(pdfTarget, dir), { recursive: true });
}
fs.writeFileSync(path.join(pdfTarget, 'VERSION'), JSON.parse(fs.readFileSync(path.join(pdfjsRoot, 'package.json'), 'utf8')).version);
console.log(`PDF.js assets copied to ${path.relative(root, pdfTarget)}`);

const katexRoot = path.dirname(require.resolve('katex/package.json'));
const katexTarget = path.join(root, 'static', 'katex');
fs.rmSync(katexTarget, { recursive: true, force: true });
fs.mkdirSync(katexTarget, { recursive: true });
fs.copyFileSync(path.join(katexRoot, 'dist', 'katex.min.css'), path.join(katexTarget, 'katex.min.css'));
fs.cpSync(path.join(katexRoot, 'dist', 'fonts'), path.join(katexTarget, 'fonts'), {
	recursive: true,
	// woff2 is all current browsers need.
	filter: (src) => fs.statSync(src).isDirectory() || src.endsWith('.woff2')
});
console.log(`KaTeX assets copied to ${path.relative(root, katexTarget)}`);
