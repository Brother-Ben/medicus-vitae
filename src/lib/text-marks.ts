// Highlights in plain text (the CARS passage player): character spans
// [start, end), end not included, per paragraph. Lists are kept sorted with no
// overlaps or touching ends, so removing part of a highlight splits it cleanly.

export type Span = [number, number];

export interface Segment {
	text: string;
	start: number;
	end: number;
	hl: boolean;
}

function clean(span: readonly number[]): Span {
	const a = Math.max(0, Math.floor(Math.min(span[0], span[1])));
	const b = Math.max(0, Math.floor(Math.max(span[0], span[1])));
	return [a, b];
}

/** The spans with `add` highlighted too (joined with any it overlaps or touches). */
export function addSpan(spans: readonly Span[], add: Span): Span[] {
	const [a, b] = clean(add);
	const all = spans.map(clean).filter(([x, y]) => y > x);
	if (b > a) all.push([a, b]);
	all.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	const out: Span[] = [];
	for (const s of all) {
		const last = out[out.length - 1];
		if (last && s[0] <= last[1]) last[1] = Math.max(last[1], s[1]);
		else out.push([s[0], s[1]]);
	}
	return out;
}

/** The spans with `cut` taken out; a highlight cut in the middle becomes two. */
export function removeSpan(spans: readonly Span[], cut: Span): Span[] {
	const [c0, c1] = clean(cut);
	const out: Span[] = [];
	for (const [a, b] of addSpan(spans, [0, 0])) {
		if (b <= c0 || a >= c1) {
			out.push([a, b]);
			continue;
		}
		if (a < c0) out.push([a, c0]);
		if (b > c1) out.push([c1, b]);
	}
	return out;
}

/** Whether all of [start, end) is highlighted. */
export function coversSpan(spans: readonly Span[], span: Span): boolean {
	const [a, b] = clean(span);
	return addSpan(spans, [0, 0]).some(([x, y]) => x <= a && y >= b);
}

/** Whether any of [start, end) is highlighted. */
export function overlapsSpan(spans: readonly Span[], span: Span): boolean {
	const [a, b] = clean(span);
	return spans.some(([x, y]) => x < b && y > a);
}

/** The text cut into plain and highlighted runs, in order. */
export function segments(text: string, spans: readonly Span[] | undefined): Segment[] {
	const out: Segment[] = [];
	let at = 0;
	for (const [a0, b0] of addSpan(spans ?? [], [0, 0])) {
		const a = Math.min(a0, text.length);
		const b = Math.min(b0, text.length);
		if (b <= a) continue;
		if (a > at) out.push({ text: text.slice(at, a), start: at, end: a, hl: false });
		out.push({ text: text.slice(a, b), start: a, end: b, hl: true });
		at = b;
	}
	if (at < text.length || !out.length) out.push({ text: text.slice(at), start: at, end: text.length, hl: false });
	return out;
}
