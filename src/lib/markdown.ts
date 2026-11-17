import { Marked, type Tokens } from 'marked';
import { cardSides, type NoteKind } from './cards';

// Markdown for annotations and card fields. Raw HTML in the source is shown as
// text and links are limited to safe schemes, so rendered content can't run
// script. Same output on the server and in the browser.

function escapeHtml(s: string) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function safeUrl(href: string | null | undefined): string | null {
	if (!href) return null;
	const h = href.trim();
	if (/^(https?:|mailto:)/i.test(h) || h.startsWith('/') || h.startsWith('#')) return h;
	if (!/^[a-z][a-z0-9+.-]*:/i.test(h)) return h;
	return null;
}

const md = new Marked({ gfm: true, breaks: true, async: false });
md.use({
	renderer: {
		html(token: Tokens.HTML | Tokens.Tag) {
			return escapeHtml(token.text);
		},
		link(this: { parser: { parseInline(t: Tokens.Generic[]): string } }, token: Tokens.Link) {
			const text = this.parser.parseInline(token.tokens);
			const href = safeUrl(token.href);
			if (!href) return text;
			const external = /^https?:/i.test(href);
			return `<a href="${escapeHtml(href)}"${external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
		},
		image(token: Tokens.Image) {
			const src = safeUrl(token.href);
			if (!src) return escapeHtml(token.text);
			return `<img src="${escapeHtml(src)}" alt="${escapeHtml(token.text)}" loading="lazy">`;
		}
	}
});

export function renderMarkdown(source: string): string {
	if (!source?.trim()) return '';
	return md.parse(source) as string;
}

/** Inline-only rendering (no paragraphs), for short labels. */
export function renderInline(source: string): string {
	if (!source?.trim()) return '';
	return md.parseInline(source) as string;
}

const CLOZE_HTML = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

function applyCloze(html: string, n: number, side: 'front' | 'back') {
	return html.replace(CLOZE_HTML, (_all, num: string, answer: string, hint?: string) => {
		if (Number(num) !== n) return answer;
		if (side === 'front') return `<span class="cloze">[${hint ? hint : '…'}]</span>`;
		return `<span class="cloze">${answer}</span>`;
	});
}

/** HTML for one side of a card. (Anki notes are rendered with their own templates on the server instead.) */
export function renderCardSide(kind: NoteKind, fields: Record<string, string>, ord: number, side: 'front' | 'back'): string {
	if (kind === 'anki') {
		const sides = cardSides(kind, fields, ord);
		return escapeHtml(side === 'front' ? sides.front : sides.back).replace(/\n/g, '<br>');
	}
	if (kind === 'cloze') {
		const n = ord + 1;
		let html = applyCloze(renderMarkdown(fields['Text'] ?? ''), n, side);
		const extra = fields['Back Extra'] ?? '';
		if (side === 'back' && extra.trim()) html += `<hr>${renderMarkdown(extra)}`;
		return html;
	}
	const front = fields['Front'] ?? '';
	const back = fields['Back'] ?? '';
	const [q, a] = ord === 1 ? [back, front] : [front, back];
	return renderMarkdown(side === 'front' ? q : a);
}
