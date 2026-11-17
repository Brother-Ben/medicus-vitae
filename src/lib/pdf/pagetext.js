// Builds a page's plain text from PDF.js text items, plus one box per item.
// Shared verbatim by the server (book import, worker thread) and the browser
// (reader selections), so character offsets mean the same thing in both places.
// Plain JavaScript on purpose: the worker loads it without a build step.

/** Bump when the algorithm changes; stored as part of each document version. */
export const PAGE_TEXT_VERSION = 1;

/**
 * @typedef {{ str?: string, transform?: number[], width?: number, height?: number, fontName?: string, hasEOL?: boolean }} TextItemLike
 * @typedef {{ ascent?: number, descent?: number }} TextStyleLike
 * @typedef {[number, number, number, number, number, number]} Run  [start, end, x0, y0, x1, y1]
 */

/** @param {number[]} m1 @param {number[]} m2 */
function multiply(m1, m2) {
	return [
		m1[0] * m2[0] + m1[2] * m2[1],
		m1[1] * m2[0] + m1[3] * m2[1],
		m1[0] * m2[2] + m1[2] * m2[3],
		m1[1] * m2[2] + m1[3] * m2[3],
		m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
		m1[1] * m2[4] + m1[3] * m2[5] + m1[5]
	];
}

/** @param {number} v */
function round4(v) {
	return Math.round(Math.min(1, Math.max(0, v)) * 10000) / 10000;
}

/**
 * @param {TextItemLike[]} items text items in content order (marked-content entries are skipped)
 * @param {{ transform: number[], width: number, height: number }} viewport viewport at scale 1
 * @param {Record<string, TextStyleLike>} [styles]
 * @returns {{ text: string, runs: Run[] }} runs[k] belongs to the k-th text item
 */
export function buildPageText(items, viewport, styles = {}) {
	let text = '';
	/** @type {Run[]} */
	const runs = [];
	/** @type {{ x1: number, y: number, size: number, eol: boolean } | null} */
	let prev = null;

	for (const item of items) {
		if (typeof item.str !== 'string') continue;
		const str = item.str;
		const t = item.transform ?? [1, 0, 0, 1, 0, 0];
		const m = multiply(viewport.transform, t);
		const sx = Math.hypot(t[0], t[1]) || 1;
		const size = Math.hypot(m[2], m[3]) || 1;
		const style = (item.fontName && styles[item.fontName]) || {};
		const ascent = typeof style.ascent === 'number' && style.ascent > 0 ? style.ascent : 0.8;
		const descent = typeof style.descent === 'number' ? style.descent : -0.2;
		const w = (item.width ?? 0) / sx;

		// Corners of the glyph box in text space, mapped to page pixels.
		const corners = [
			[0, descent],
			[w, descent],
			[w, ascent],
			[0, ascent]
		].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
		const xs = corners.map((c) => c[0]);
		const ys = corners.map((c) => c[1]);
		const x0 = Math.min(...xs);
		const x1 = Math.max(...xs);
		const y0 = Math.min(...ys);
		const y1 = Math.max(...ys);
		const baselineY = m[5];

		if (prev && !prev.eol && str.length > 0) {
			const sameLine = Math.abs(baselineY - prev.y) < Math.max(size, prev.size) * 0.5;
			const endsWithSpace = /\s$/.test(text);
			const startsWithSpace = /^\s/.test(str);
			if (!sameLine) {
				if (!endsWithSpace) text += '\n';
			} else if (!endsWithSpace && !startsWithSpace && x0 - prev.x1 > size * 0.12) {
				text += ' ';
			}
		}

		const start = text.length;
		text += str;
		const end = text.length;
		runs.push([
			start,
			end,
			round4(x0 / viewport.width),
			round4(y0 / viewport.height),
			round4(x1 / viewport.width),
			round4(y1 / viewport.height)
		]);
		if (item.hasEOL) text += '\n';
		if (str.length > 0 || item.hasEOL) {
			prev = { x1, y: baselineY, size, eol: !!item.hasEOL };
		}
	}
	return { text, runs };
}

/**
 * Boxes covering text[start, end) on a page, merged per line.
 * @param {Run[]} runs
 * @param {number} start
 * @param {number} end
 * @returns {number[][]} [[x0, y0, x1, y1], ...]
 */
export function rectsForRange(runs, start, end) {
	/** @type {number[][]} */
	const rects = [];
	for (const [s, e, x0, y0, x1, y1] of runs) {
		if (e <= start || s >= end || e === s) continue;
		const len = e - s;
		const from = Math.max(start, s) - s;
		const to = Math.min(end, e) - s;
		const w = x1 - x0;
		const rx0 = x0 + (w * from) / len;
		const rx1 = x0 + (w * to) / len;
		const last = rects[rects.length - 1];
		if (last && Math.abs(last[1] - y0) < 0.004 && Math.abs(last[3] - y1) < 0.004 && rx0 - last[2] < 0.02) {
			last[2] = Math.max(last[2], rx1);
		} else {
			rects.push([round4(rx0), round4(y0), round4(rx1), round4(y1)]);
		}
	}
	return rects;
}

/** Collapses whitespace so stored quotes compare reliably. @param {string} s */
export function normalizeQuote(s) {
	return s.replace(/\s+/g, ' ').trim();
}
