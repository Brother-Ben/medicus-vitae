import { htmlToText } from '../../cards';
import { clozeNumbersIn, revealClozeText, revealClozeTextOnly } from './cloze';
import { cleanCardHtml } from './html';

// Anki card templates (a port of rslib/src/template.rs and template_filters.rs):
// {{Field}}, {{#Field}}…{{/Field}}, {{^Field}}…{{/Field}}, filters such as
// cloze:, text:, hint:, type:, furigana:, and the special fields FrontSide,
// Tags, Type, Deck, Subdeck, Card and CardFlag. The output keeps the deck's
// scripts: it is only ever shown inside the sealed card frame (AnkiCard.svelte).

type TNode =
	| { t: 'text'; text: string }
	| { t: 'comment'; text: string }
	| { t: 'replace'; key: string; filters: string[] }
	| { t: 'if'; key: string; negated: boolean; children: TNode[] };

type Token =
	| { t: 'text'; text: string }
	| { t: 'comment'; text: string }
	| { t: 'replace'; text: string }
	| { t: 'open'; key: string; negated: boolean }
	| { t: 'close'; key: string };

class TemplateError extends Error {}

const ALT_DIRECTIVE = '{{=<% %>=}}';

function classify(inner: string): Token {
	const s = inner.replace(/^\{+/, '').trim();
	if (s.length < 2) return { t: 'replace', text: s };
	if (s.startsWith('#')) return { t: 'open', key: s.slice(1).trimStart(), negated: false };
	if (s.startsWith('/')) return { t: 'close', key: s.slice(1).trimStart() };
	if (s.startsWith('^')) return { t: 'open', key: s.slice(1).trimStart(), negated: true };
	return { t: 'replace', text: s };
}

function tokenize(template: string): Token[] {
	let src = template;
	let start = '{{';
	let end = '}}';
	if (src.trimStart().startsWith(ALT_DIRECTIVE)) {
		src = src.trimStart().slice(ALT_DIRECTIVE.length);
		start = '<%';
		end = '%>';
	}
	const out: Token[] = [];
	let i = 0;
	let textStart = 0;
	const pushText = (upTo: number) => {
		if (upTo > textStart) out.push({ t: 'text', text: src.slice(textStart, upTo) });
	};
	while (i < src.length) {
		if (src.startsWith(start, i)) {
			const close = src.indexOf(end, i + start.length);
			if (close !== -1) {
				pushText(i);
				out.push(classify(src.slice(i + start.length, close)));
				i = close + end.length;
				textStart = i;
				continue;
			}
		}
		if (src.startsWith('<!--', i)) {
			const close = src.indexOf('-->', i + 4);
			if (close !== -1) {
				pushText(i);
				out.push({ t: 'comment', text: src.slice(i + 4, close) });
				i = close + 3;
				textStart = i;
				continue;
			}
		}
		i++;
	}
	pushText(src.length);
	return out;
}

function parseTokens(tokens: Token[], pos: { i: number }, open: string | null): TNode[] {
	const nodes: TNode[] = [];
	while (pos.i < tokens.length) {
		const tok = tokens[pos.i++];
		if (tok.t === 'text') nodes.push({ t: 'text', text: tok.text });
		else if (tok.t === 'comment') nodes.push({ t: 'comment', text: tok.text });
		else if (tok.t === 'replace') {
			const parts = tok.text.split(':');
			const key = parts.pop() ?? '';
			nodes.push({ t: 'replace', key, filters: parts.reverse() });
		} else if (tok.t === 'open') {
			nodes.push({ t: 'if', key: tok.key, negated: tok.negated, children: parseTokens(tokens, pos, tok.key) });
		} else {
			if (open === tok.key) return nodes;
			throw new TemplateError(
				open ? `Found {{/${tok.key}}}, but expected {{/${open}}}.` : `Found {{/${tok.key}}}, but it was never opened.`
			);
		}
	}
	if (open !== null) throw new TemplateError(`Missing {{/${open}}}.`);
	return nodes;
}

export function parseTemplate(template: string): TNode[] {
	return parseTokens(tokenize(template), { i: 0 }, null);
}

export function fieldIsEmpty(text: string) {
	return /^(?:\s|<\/?(?:br|div) ?\/?>)*$/i.test(text);
}

function isClozeConditional(key: string) {
	return /^c\d+$/.test(key);
}

/** Whether a template shows anything with these non-empty fields (Anki's empty-card rule). */
function templateIsEmpty(nonempty: Set<string>, nodes: TNode[]): boolean {
	for (const n of nodes) {
		if (n.t === 'replace') {
			if (nonempty.has(n.key)) return false;
		} else if (n.t === 'if') {
			if (!n.negated && !nonempty.has(n.key)) continue;
			if (n.negated && nonempty.has(n.key)) continue;
			if (!templateIsEmpty(nonempty, n.children)) return false;
		}
	}
	return true;
}

function escapeHtml(s: string) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const FURIGANA = / ?([^ >]+?)\[(.+?)\]/g;

interface Ctx {
	fields: Map<string, string>;
	nonempty: Set<string>;
	ord: number;
	frontside: string | null;
}

function applyFilter(name: string, text: string, field: string, ctx: Ctx): string | null {
	const question = ctx.frontside === null;
	switch (name) {
		case 'text':
			// Like Anki's strip_html: tags removed outright (no spaces added), entities decoded.
			return escapeHtml(htmlToText(text.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/<[^>]*>/g, '')));
		case 'hint':
			return text.trim() ? `<details class="hint"><summary>${escapeHtml(field)}</summary>${text}</details>` : text;
		case 'cloze':
			return revealClozeText(text, ctx.ord + 1, question);
		case 'cloze-only':
			return revealClozeTextOnly(text, ctx.ord + 1, question);
		case 'furigana':
			return text.replace(/&nbsp;/g, ' ').replace(FURIGANA, (m, base: string, ruby: string) => (ruby.startsWith('sound:') ? m : `<ruby><rb>${base}</rb><rt>${ruby}</rt></ruby>`));
		case 'kanji':
			return text.replace(/&nbsp;/g, ' ').replace(FURIGANA, (m, base: string, ruby: string) => (ruby.startsWith('sound:') ? m : base));
		case 'kana':
			return text.replace(/&nbsp;/g, ' ').replace(FURIGANA, (m, _b: string, ruby: string) => (ruby.startsWith('sound:') ? m : ruby));
		case 'type':
			return `[[type:${field}]]`;
		case '':
			return text;
		default:
			if (name.startsWith('tts ')) return `[anki:tts lang=${name.slice(4)}]${text}[/anki:tts]`;
			return null; // unknown filters (add-ons) are ignored, as in Anki
	}
}

function lookup(fields: Map<string, string>, key: string): string | undefined {
	if (fields.has(key)) return fields.get(key);
	const lower = key.toLowerCase();
	for (const [k, v] of fields) if (k.toLowerCase() === lower) return v;
	return undefined;
}

function renderNodes(nodes: TNode[], ctx: Ctx): string {
	let out = '';
	for (const n of nodes) {
		if (n.t === 'text') out += n.text;
		else if (n.t === 'comment') out += `<!--${n.text}-->`;
		else if (n.t === 'replace') {
			if (n.key === 'FrontSide') {
				out += ctx.frontside ?? '';
				continue;
			}
			if (!n.key) continue;
			const value = lookup(ctx.fields, n.key);
			if (value === undefined) throw new TemplateError(`Found {{${[...n.filters].reverse().concat(n.key).join(':')}}}, but there is no field called “${n.key}”.`);
			if (n.filters[n.filters.length - 1] === 'type') {
				const modifiers = n.filters.slice(0, -1).filter((m) => m === 'cloze' || m === 'nc');
				out += `[[type:${modifiers.map((m) => m + ':').join('')}${n.key}]]`;
				continue;
			}
			let text = value;
			for (const f of n.filters) {
				const next = applyFilter(f, text, n.key, ctx);
				if (next !== null) text = next;
			}
			out += text;
		} else {
			const has = ctx.nonempty.has(n.key) || [...ctx.nonempty].some((k) => k.toLowerCase() === n.key.toLowerCase());
			if (!has && lookup(ctx.fields, n.key) === undefined && !isClozeConditional(n.key)) {
				throw new TemplateError(`Found {{${n.negated ? '^' : '#'}${n.key}}}, but there is no field called “${n.key}”.`);
			}
			if (has !== n.negated) out += renderNodes(n.children, ctx);
		}
	}
	return out;
}

/** [[type:…]] placeholders: no typing box here; the answer side shows the expected answer instead. */
function resolveTypeAnswers(html: string, ctx: Ctx, side: 'question' | 'answer'): string {
	return html.replace(/\[\[type:((?:cloze:|nc:)*)([^\]]+)\]\]/g, (_m, mods: string, field: string) => {
		if (side === 'question') return '';
		const value = lookup(ctx.fields, field) ?? '';
		const expected = mods.includes('cloze:') ? revealClozeTextOnly(value, ctx.ord + 1, false) : value;
		return `<div class="typed-answer">${escapeHtml(htmlToText(expected).trim())}</div>`;
	});
}

export interface AnkiNoteTypeShape {
	name: string;
	kind: 'standard' | 'cloze';
	fields: string[];
	templates: { name: string; front: string; back: string }[];
}

export interface RenderedCard {
	question: string;
	answer: string;
	/** Scripts or event handlers were removed from what Anki would have run (never, now that the frame runs them). */
	removedScript: boolean;
	math: boolean;
	empty: boolean;
}

export function renderAnkiCard(
	type: AnkiNoteTypeShape,
	noteFields: Record<string, string>,
	ord: number,
	extra: { tags: string[]; deck: string | null; flag?: number }
): RenderedCard {
	const template = type.kind === 'cloze' ? type.templates[0] : type.templates[ord];
	const fields = new Map<string, string>();
	for (const name of type.fields) fields.set(name, noteFields[name] ?? '');
	for (const [k, v] of Object.entries(noteFields)) if (!fields.has(k)) fields.set(k, v);
	const nonempty = new Set([...fields].filter(([, v]) => !fieldIsEmpty(v)).map(([k]) => k));
	const deck = extra.deck ?? '';
	const specials: Record<string, string> = {
		Tags: extra.tags.join(' '),
		Type: type.name,
		Deck: deck,
		Subdeck: deck.split('::').pop() ?? '',
		Card: template?.name ?? '',
		CardFlag: extra.flag ? `flag${extra.flag}` : ''
	};
	for (const [k, v] of Object.entries(specials)) {
		if (!fields.has(k)) {
			fields.set(k, v);
			if (v) nonempty.add(k);
		}
	}
	if (type.kind === 'cloze') {
		fields.set(`c${ord + 1}`, '1');
		nonempty.add(`c${ord + 1}`);
	}

	const problem = (message: string): RenderedCard => {
		const html = `<div class="card-problem">${escapeHtml(message)}</div>`;
		return { question: html, answer: html, removedScript: false, math: false, empty: true };
	};
	if (!template) return problem('This card’s template is missing from its note type.');

	try {
		const ctx: Ctx = { fields, nonempty, ord, frontside: null };
		const qNodes = parseTemplate(template.front);
		const qRaw = renderNodes(qNodes, ctx);
		if (type.kind === 'cloze') {
			const used = new Set<number>();
			for (const name of type.fields) for (const n of clozeNumbersIn(noteFields[name] ?? '')) used.add(n);
			if (!used.has(ord + 1)) return problem(`Cloze ${ord + 1} no longer exists in this note.`);
		} else if (templateIsEmpty(nonempty, qNodes)) {
			return problem('The front of this card is empty.');
		}
		ctx.frontside = qRaw;
		const aRaw = renderNodes(parseTemplate(template.back), ctx);
		const q = cleanCardHtml(resolveTypeAnswers(qRaw, ctx, 'question'), 'frame');
		const a = cleanCardHtml(resolveTypeAnswers(aRaw, ctx, 'answer'), 'frame');
		return { question: q.html, answer: a.html, removedScript: q.removedScript || a.removedScript, math: q.math || a.math, empty: false };
	} catch (err) {
		if (err instanceof TemplateError) return problem(`Card template problem: ${err.message}`);
		throw err;
	}
}
