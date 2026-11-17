// Cloze deletions the way Anki renders them (a port of rslib/src/cloze.rs):
// nested clozes, several numbers on one deletion ({{c1,2::…}}), hints, and
// MathJax-aware closing, so `}}` inside \( … \) doesn't end a deletion early.

type Token = { t: 'open'; ords: number[] } | { t: 'text'; text: string } | { t: 'close' };

interface Cloze {
	ords: number[];
	nodes: Node[];
	hint: string | null;
}

type Node = string | Cloze;

const OPEN = /^\{\{c([\d,]+)::/;

function openAt(text: string, i: number): { ords: number[]; len: number } | null {
	if (!text.startsWith('{{c', i)) return null;
	const m = OPEN.exec(text.slice(i, i + 64));
	if (!m) return null;
	const ords = [...new Set(m[1].split(',').filter(Boolean).map(Number))].filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
	if (!ords.length) return null;
	return { ords, len: m[0].length };
}

class MathJaxState {
	current: { close: string; id: number } | null = null;
	nextId = 0;
	regions: (number | null)[] = [];

	region() {
		return this.current ? this.current.id : null;
	}

	/** Outside MathJax, `}}` always closes a cloze. Inside, only one opened in the same expression. */
	canClose() {
		const r = this.region();
		return r === null || this.regions[this.regions.length - 1] === r;
	}

	consumeDelimiter(text: string, i: number): number | null {
		if (!this.current) {
			for (const [open, close] of [
				['\\(', '\\)'],
				['\\[', '\\]']
			]) {
				if (text.startsWith(open, i) && text.indexOf(close, i + open.length) !== -1) {
					this.current = { close, id: this.nextId++ };
					return open.length;
				}
			}
			return null;
		}
		if (text.startsWith(this.current.close, i)) {
			const n = this.current.close.length;
			this.current = null;
			return n;
		}
		return null;
	}
}

function tokenize(text: string): Token[] {
	const out: Token[] = [];
	const state = new MathJaxState();
	let i = 0;
	while (i < text.length) {
		const open = openAt(text, i);
		if (open) {
			state.regions.push(state.region());
			out.push({ t: 'open', ords: open.ords });
			i += open.len;
			continue;
		}
		if (state.canClose() && text.startsWith('}}', i)) {
			state.regions.pop();
			out.push({ t: 'close' });
			i += 2;
			continue;
		}
		let j = i;
		while (j < text.length) {
			if (openAt(text, j) || (state.canClose() && text.startsWith('}}', j))) break;
			j += state.consumeDelimiter(text, j) ?? 1;
		}
		out.push({ t: 'text', text: text.slice(i, j) });
		i = j;
	}
	return out;
}

function parse(text: string): Node[] {
	const open: Cloze[] = [];
	const output: Node[] = [];
	for (const tok of tokenize(text)) {
		if (tok.t === 'open') {
			if (open.length < 10) open.push({ ords: tok.ords, nodes: [], hint: null });
		} else if (tok.t === 'text') {
			const top = open[open.length - 1];
			if (top) {
				let t = tok.text;
				if (!t.startsWith('image-occlusion:')) {
					const k = t.indexOf('::');
					if (k !== -1) {
						top.hint = t.slice(k + 2);
						t = t.slice(0, k);
					}
				}
				top.nodes.push(t);
			} else {
				output.push(tok.text);
			}
		} else {
			const c = open.pop();
			if (c) (open[open.length - 1]?.nodes ?? output).push(c);
			else output.push('}}');
		}
	}
	return output;
}

function attr(s: string) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;');
}

function clozedText(c: Cloze): string {
	return c.nodes.map((n) => (typeof n === 'string' ? n : clozedText(n))).join('');
}

function isImageOcclusion(c: Cloze) {
	return typeof c.nodes[0] === 'string' && c.nodes[0].startsWith('image-occlusion:');
}

const IO_PROPERTIES: Record<string, string> = {
	left: 'data-left',
	top: 'data-top',
	width: 'data-width',
	height: 'data-height',
	rx: 'data-rx',
	ry: 'data-ry',
	points: 'data-points',
	oi: 'data-occludeinactive',
	text: 'data-text',
	scale: 'data-scale',
	fs: 'data-font-size',
	angle: 'data-angle',
	fill: 'data-fill'
};

/** Shape data of an image occlusion mask, as data- attributes (Anki's get_image_cloze_data). */
function imageClozeData(text: string): string {
	const parts = text.split(':');
	let out = parts[1] ? ` data-shape="${attr(parts[1])}"` : '';
	for (const part of parts.slice(2)) {
		const eq = part.indexOf('=');
		if (eq === -1) continue;
		const name = IO_PROPERTIES[part.slice(0, eq)];
		if (name) out += ` ${name}="${attr(part.slice(eq + 1))}"`;
	}
	return out;
}

function reveal(c: Cloze, ord: number, question: boolean, found: { active: boolean }): string {
	const active = c.ords.includes(ord);
	found.active ||= active;
	const ords = c.ords.join(',');
	if (isImageOcclusion(c)) {
		// Rendered like Anki: the frame draws these masks over the image (anki.imageOcclusion.setup()).
		const data = imageClozeData(String(c.nodes[0]));
		const cls = c.ords.includes(0) || (question && active) ? 'cloze' : !active ? 'cloze-inactive' : 'cloze-highlight';
		return `<div class="${cls}" data-ordinal="${ords}"${data}></div>`;
	}
	const inner = () => c.nodes.map((n) => (typeof n === 'string' ? n : reveal(n, ord, question, found))).join('');
	if (question && active) {
		const content = inner();
		return `<span class="cloze" data-cloze="${attr(content)}" data-ordinal="${ords}">[${c.hint ?? '...'}]</span>`;
	}
	if (!question && active) return `<span class="cloze" data-ordinal="${ords}">${inner()}</span>`;
	return `<span class="cloze-inactive" data-ordinal="${ords}">${inner()}</span>`;
}

/** One card's view of a cloze field. Empty when the field has no deletion with that number. */
export function revealClozeText(text: string, ord: number, question: boolean): string {
	const found = { active: false };
	const html = parse(text)
		.map((n) => (typeof n === 'string' ? n : reveal(n, ord, question, found)))
		.join('');
	return found.active ? html : '';
}

/** Just the active deletions' text (or hints on the question side), for the `cloze-only:` filter. */
export function revealClozeTextOnly(text: string, ord: number, question: boolean): string {
	const out: string[] = [];
	const walk = (n: Node) => {
		if (typeof n === 'string') return;
		if (n.ords.includes(ord)) out.push(question ? (n.hint ?? '...') : clozedText(n));
		n.nodes.forEach(walk);
	};
	parse(text).forEach(walk);
	return out.join(', ');
}

/** Cloze numbers used in a field (1-based, excluding 0). */
export function clozeNumbersIn(text: string): Set<number> {
	const set = new Set<number>();
	const walk = (n: Node) => {
		if (typeof n === 'string') return;
		for (const o of n.ords) if (o !== 0) set.add(o);
		n.nodes.forEach(walk);
	};
	parse(text).forEach(walk);
	return set;
}

export function hasImageOcclusionCloze(text: string) {
	return /\{\{c[\d,]+::image-occlusion:/.test(text);
}
