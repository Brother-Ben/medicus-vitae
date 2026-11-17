import { rectsForRange } from '../../pdf/pagetext.js';

// Splits book pages into passages the tutor can cite, and finds figures and
// tables by their captions so they can be cited as page regions (LIB-08).

export interface Span {
	start: number;
	end: number;
}

const MAX = 900;
const MIN = 240;

/** Sentence-ish boundaries in a page's text. */
function boundaries(text: string): number[] {
	const out = [0];
	for (const m of text.matchAll(/[.!?]["'”’)\]]?\s+|\n\s*\n/g)) out.push(m.index + m[0].length);
	out.push(text.length);
	return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Passages of up to ~900 characters along sentence boundaries, each starting
 * with the previous passage's last sentence (when short) so ideas that cross a
 * boundary are still found together.
 */
export function splitPage(text: string): Span[] {
	const trimmedEnd = text.trimEnd().length;
	if (!text.trim()) return [];
	const b = boundaries(text.slice(0, trimmedEnd)).filter((x) => x <= trimmedEnd);
	const sentences: Span[] = [];
	for (let i = 0; i < b.length - 1; i++) {
		let s = b[i];
		const e = b[i + 1];
		// Over-long "sentences" (tables, lists) are cut at whitespace.
		while (e - s > MAX) {
			let cut = text.lastIndexOf(' ', s + MAX);
			if (cut <= s + MIN) cut = s + MAX;
			sentences.push({ start: s, end: cut });
			s = cut;
		}
		if (e > s) sentences.push({ start: s, end: e });
	}
	const out: Span[] = [];
	let cur: Span | null = null;
	let last: Span | null = null;
	for (const sent of sentences) {
		if (!cur) cur = { ...sent };
		else if (sent.end - cur.start <= MAX) cur.end = sent.end;
		else {
			out.push(cur);
			const overlap = last && last.end - last.start < 200 && sent.end - last.start <= MAX ? last : null;
			cur = { start: overlap ? overlap.start : sent.start, end: sent.end };
		}
		last = sent;
	}
	if (cur) {
		// Fold a short tail into the passage before it.
		const prev = out[out.length - 1];
		if (prev && cur.end - cur.start < MIN && cur.end - prev.start <= MAX * 1.3) prev.end = cur.end;
		else out.push(cur);
	}
	return out.filter((s) => text.slice(s.start, s.end).trim().length >= 20);
}

export function cleanPassage(text: string) {
	return text
		.replace(/(\w)-\n(\w)/g, '$1$2')
		.replace(/\s+/g, ' ')
		.trim();
}

type Run = [number, number, number, number, number, number];

export interface FigureRegion {
	captionStart: number;
	captionEnd: number;
	caption: string;
	rects: number[][];
}

const CAPTION = /(^|\n)[ \t]*((?:Figure|Fig\.|Table|Equation|Eq\.|Diagram|Graph|Chart)\s*[A-Z]?\d+(?:[.\-–]\d+)*[a-z]?[.:]?)[ \t]+[^\n]{2,}/g;

function union(rects: number[][]) {
	return [Math.min(...rects.map((r) => r[0])), Math.min(...rects.map((r) => r[1])), Math.max(...rects.map((r) => r[2])), Math.max(...rects.map((r) => r[3]))];
}

const round = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;

/**
 * Figures and tables found by their captions. The region is the caption plus
 * the empty-of-text area next to it (where the drawing or table sits): above it
 * for figures, below it for tables, whichever side has the larger gap.
 */
export function findFigures(text: string, runs: Run[]): FigureRegion[] {
	const out: FigureRegion[] = [];
	if (!runs.length) return out;
	const left = Math.min(...runs.map((r) => r[2]));
	const right = Math.max(...runs.map((r) => r[4]));
	for (const m of text.matchAll(CAPTION)) {
		const start = m.index + m[0].indexOf(m[2], m[1].length);
		let end = text.indexOf('\n', start);
		if (end === -1) end = text.length;
		// Captions often wrap: take following lines until a blank line or ~300 characters.
		while (end < text.length && end - start < 300) {
			const next = text.indexOf('\n', end + 1);
			const line = text.slice(end + 1, next === -1 ? text.length : next);
			if (!line.trim() || /^[A-Z][A-Za-z ]{0,40}$/.test(line.trim())) break;
			end = next === -1 ? text.length : next;
		}
		const capRects = rectsForRange(runs, start, end);
		if (!capRects.length) continue;
		const cap = union(capRects);
		const others = runs.filter((r) => (r[1] <= start || r[0] >= end) && r[1] > r[0] && r[4] > cap[0] - 0.05 && r[2] < cap[2] + 0.05);
		const above = others.filter((r) => r[5] <= cap[1] + 0.002);
		const below = others.filter((r) => r[3] >= cap[3] - 0.002);
		const topEdge = above.length ? Math.max(...above.map((r) => r[5])) : 0.04;
		const bottomEdge = below.length ? Math.min(...below.map((r) => r[3])) : 0.96;
		const gapAbove = cap[1] - topEdge;
		const gapBelow = bottomEdge - cap[3];
		const isTable = /^table/i.test(m[2]);
		let region: number[];
		if (gapAbove >= 0.06 && (!isTable || gapAbove >= gapBelow)) region = [left, topEdge + 0.004, right, cap[3] + 0.004];
		else if (gapBelow >= 0.06) region = [left, cap[1] - 0.004, right, bottomEdge - 0.004];
		else region = [cap[0] - 0.01, cap[1] - 0.004, cap[2] + 0.01, cap[3] + 0.004];
		out.push({
			captionStart: start,
			captionEnd: end,
			caption: cleanPassage(text.slice(start, end)),
			rects: [region.map(round)]
		});
	}
	return out;
}
