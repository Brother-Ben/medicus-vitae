import { normalizeQuote } from '../pdf/pagetext.js';

// Turns a browser selection on a PDF page's text layer (or a drawn box) into a
// source anchor: page, regions as 0–1 fractions of the page, character offsets
// into the same page text the server indexed, and the exact quote with context.

export interface AnchorInputClient {
	documentId: string;
	versionId: string;
	page: number;
	kind: 'text' | 'region';
	rects: number[][];
	textStart?: number | null;
	textEnd?: number | null;
	exact?: string;
	prefix?: string;
	suffix?: string;
}

export interface PageText {
	text: string;
	runs: number[][];
	/** Text-layer elements, aligned with runs. */
	divs: HTMLElement[];
	divIndex: Map<Element, number>;
}

function clamp01(v: number) {
	return Math.min(1, Math.max(0, v));
}

/** Character offset in the page text for a DOM boundary point inside the text layer. */
function boundaryOffset(node: Node, offset: number, pt: PageText, layer: HTMLElement, isEnd: boolean): number | null {
	let el: Node | null = node;
	let within = offset;
	if (node.nodeType === Node.TEXT_NODE) {
		el = node.parentElement;
	} else if (node === layer) {
		// Offset counts child nodes of the layer: use the neighbouring child.
		const child = layer.childNodes[Math.min(offset, layer.childNodes.length - 1)];
		if (!child) return null;
		el = child;
		within = isEnd && offset >= layer.childNodes.length ? Number.MAX_SAFE_INTEGER : 0;
	} else {
		within = offset > 0 ? Number.MAX_SAFE_INTEGER : 0;
	}
	// Walk up to the text-layer span for this item (marked content can nest spans).
	while (el && el !== layer && !(el instanceof Element && pt.divIndex.has(el))) el = el.parentNode;
	if (!el || el === layer) {
		// A <br> or the end-of-content element: snap to the closest item before it.
		let prev: Node | null = node.nodeType === Node.TEXT_NODE ? node.parentNode : node;
		while (prev && prev !== layer && !(prev instanceof Element && pt.divIndex.has(prev))) {
			prev = prev.previousSibling ?? prev.parentNode;
		}
		if (!prev || prev === layer) return null;
		const k = pt.divIndex.get(prev as Element)!;
		return pt.runs[k][1];
	}
	const k = pt.divIndex.get(el as Element)!;
	const [start, end] = pt.runs[k];
	return Math.min(end, start + Math.min(within, end - start));
}

function mergeRects(rects: number[][]): number[][] {
	const sorted = [...rects].sort((a, b) => a[1] - b[1] || a[0] - b[0]);
	const out: number[][] = [];
	for (const r of sorted) {
		const last = out[out.length - 1];
		const sameLine = last && Math.abs(last[1] - r[1]) < 0.006 && Math.abs(last[3] - r[3]) < 0.01;
		if (sameLine && r[0] - last[2] < 0.025) {
			last[0] = Math.min(last[0], r[0]);
			last[2] = Math.max(last[2], r[2]);
			last[1] = Math.min(last[1], r[1]);
			last[3] = Math.max(last[3], r[3]);
		} else {
			out.push([...r]);
		}
	}
	return out.map((r) => r.map((v) => Math.round(v * 10000) / 10000));
}

/** Anchor for the current selection on one page, or null if nothing usable is selected there. */
export function anchorFromSelection(
	sel: Selection,
	pageEl: HTMLElement,
	layer: HTMLElement,
	pt: PageText,
	base: { documentId: string; versionId: string; page: number }
): AnchorInputClient | null {
	if (!sel.rangeCount || sel.isCollapsed) return null;
	const range = sel.getRangeAt(0);
	if (!layer.contains(range.startContainer)) return null;
	const start = boundaryOffset(range.startContainer, range.startOffset, pt, layer, false);
	const endInPage = layer.contains(range.endContainer);
	let end = endInPage ? boundaryOffset(range.endContainer, range.endOffset, pt, layer, true) : pt.text.length;
	if (start === null || end === null) return null;
	if (end < start) end = start;

	const box = pageEl.getBoundingClientRect();
	const rects: number[][] = [];
	for (const r of Array.from(range.getClientRects())) {
		if (r.width < 1 || r.height < 1) continue;
		const x0 = clamp01((r.left - box.left) / box.width);
		const x1 = clamp01((r.right - box.left) / box.width);
		const y0 = clamp01((r.top - box.top) / box.height);
		const y1 = clamp01((r.bottom - box.top) / box.height);
		if (x1 - x0 > 0.001 && y1 - y0 > 0.001 && y0 < 1 && y1 > 0) rects.push([x0, y0, x1, y1]);
	}
	const exact = normalizeQuote(pt.text.slice(start, end)) || normalizeQuote(sel.toString());
	if (!exact || !rects.length) return null;
	return {
		...base,
		kind: 'text',
		rects: mergeRects(rects),
		textStart: start,
		textEnd: end,
		exact,
		prefix: pt.text.slice(Math.max(0, start - 48), start),
		suffix: pt.text.slice(end, end + 48)
	};
}

/** Text whose boxes fall inside a drawn region (captions, equations), for search and labels. */
export function textInRegion(pt: PageText | undefined, r: number[]): string {
	if (!pt) return '';
	const parts: string[] = [];
	for (const [s, e, x0, y0, x1, y1] of pt.runs) {
		const cx = (x0 + x1) / 2;
		const cy = (y0 + y1) / 2;
		if (cx >= r[0] && cx <= r[2] && cy >= r[1] && cy <= r[3]) parts.push(pt.text.slice(s, e));
	}
	return normalizeQuote(parts.join(' '));
}

/** Ranges in the page text matching the search words (word-start, case-insensitive). */
export function matchRanges(text: string, query: string): [number, number][] {
	const words = (query.match(/[\p{L}\p{N}]{2,}/gu) ?? []).map((w) => w.toLowerCase());
	if (!words.length) return [];
	const lower = text.toLowerCase();
	const out: [number, number][] = [];
	for (const w of words) {
		let i = 0;
		while ((i = lower.indexOf(w, i)) !== -1) {
			const before = i === 0 ? ' ' : lower[i - 1];
			if (!/[\p{L}\p{N}]/u.test(before)) {
				let end = i + w.length;
				while (end < lower.length && /[\p{L}\p{N}]/u.test(lower[end])) end++;
				out.push([i, end]);
			}
			i += w.length;
		}
	}
	return out.sort((a, b) => a[0] - b[0]);
}
