// Page ranges for book progress: which pages the owner has marked done
// (chapters checked off, or "read up to page N"). Shared by the server and the
// reader, so both agree on what counts as done. Ranges are [from, to], 1-based
// and inclusive; a "merged" list is sorted with no overlaps or touching ends.

export type PageRange = [number, number];

export function mergeRanges(ranges: readonly (readonly number[])[], pageCount?: number | null): PageRange[] {
	const clean: PageRange[] = [];
	for (const r of ranges) {
		if (!Array.isArray(r) || r.length < 2) continue;
		let a = Math.floor(Math.min(Number(r[0]), Number(r[1])));
		let b = Math.floor(Math.max(Number(r[0]), Number(r[1])));
		if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
		a = Math.max(1, a);
		if (pageCount) b = Math.min(pageCount, b);
		if (a <= b) clean.push([a, b]);
	}
	clean.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	const out: PageRange[] = [];
	for (const r of clean) {
		const last = out[out.length - 1];
		if (last && r[0] <= last[1] + 1) last[1] = Math.max(last[1], r[1]);
		else out.push([r[0], r[1]]);
	}
	return out;
}

export function addRange(ranges: readonly PageRange[], add: PageRange, pageCount?: number | null): PageRange[] {
	return mergeRanges([...ranges, add], pageCount);
}

/** The ranges with [from, to] taken out. */
export function subtractRange(ranges: readonly PageRange[], cut: PageRange): PageRange[] {
	const [c0, c1] = cut[0] <= cut[1] ? cut : [cut[1], cut[0]];
	const out: PageRange[] = [];
	for (const [a, b] of mergeRanges(ranges)) {
		if (b < c0 || a > c1) {
			out.push([a, b]);
			continue;
		}
		if (a < c0) out.push([a, c0 - 1]);
		if (b > c1) out.push([c1 + 1, b]);
	}
	return out;
}

/** Whether every page from..to is done. */
export function isCovered(ranges: readonly PageRange[], from: number, to: number): boolean {
	const lo = Math.min(from, to);
	const hi = Math.max(from, to);
	return mergeRanges(ranges).some(([a, b]) => a <= lo && b >= hi);
}

export function pagesIn(ranges: readonly PageRange[]): number {
	return mergeRanges(ranges).reduce((n, [a, b]) => n + (b - a + 1), 0);
}

export interface SectionLike {
	id: string;
	title: string;
	level: number;
	pageStart: number;
	pageEnd: number;
}

/**
 * Sections with no smaller section inside them: the units progress is counted
 * in (a chapter that has subsections counts through them).
 */
export function leafSections<T extends SectionLike>(sections: readonly T[]): T[] {
	return sections.filter(
		(s) => !sections.some((o) => o !== s && o.level > s.level && o.pageStart >= s.pageStart && o.pageEnd <= s.pageEnd)
	);
}

export interface BookProgress {
	/** Percent of the book's pages marked done, 0–100. */
	pct: number;
	pagesDone: number;
	pageCount: number;
	sectionsDone: number;
	sectionsTotal: number;
}

export function bookProgress(ranges: readonly PageRange[], pageCount: number | null, sections: readonly SectionLike[] = []): BookProgress {
	const pages = pageCount ?? 0;
	const merged = mergeRanges(ranges, pages || null);
	const pagesDone = pagesIn(merged);
	const leaves = leafSections(sections);
	return {
		pct: pages ? Math.min(100, Math.round((pagesDone / pages) * 100)) : 0,
		pagesDone,
		pageCount: pages,
		sectionsDone: leaves.filter((s) => isCovered(merged, s.pageStart, s.pageEnd)).length,
		sectionsTotal: leaves.length
	};
}

/**
 * Chapters for grouping a flat list of numbered sections ("5.1 …", "5.2 …"):
 * the leading number, or null when titles aren't numbered that way.
 */
export function chapterKey(title: string): string | null {
	const m = /^\s*(?:chapter|ch\.?|unit|part)?\s*(\d{1,3})(?:[.\-:]\d+)*\b/i.exec(title);
	return m ? m[1] : null;
}
