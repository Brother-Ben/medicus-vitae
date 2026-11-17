import { Parser } from 'htmlparser2';
import katex from 'katex';
import 'katex/contrib/mhchem';

// Prepares card HTML from Anki decks. Two modes:
//  - "frame" (cards shown in the card frame): the deck's own scripts are kept,
//    as in Anki, because many note types build the card with JavaScript. The
//    frame is sandboxed with an opaque origin, so those scripts can't reach the
//    rest of Cortex, its storage or the owner's sign-in.
//  - "clean" (anything shown in Cortex's own pages): scripts, frames, plugins,
//    event handlers and javascript: links are removed.
// Either way, MathJax-style math is typeset with KaTeX and [sound:…] tags
// become audio players.

const DROP_WITH_CONTENT = new Set(['script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'template', 'title']);
const DROP_TAG_ONLY = new Set(['html', 'head', 'body', 'form', 'base', 'meta', 'link']);
/** In the sealed frame only the document structure and <base> (it would redirect media) are dropped. */
const FRAME_DROP_WITH_CONTENT = new Set(['noscript', 'title']);
const FRAME_DROP_TAG_ONLY = new Set(['html', 'head', 'body', 'form', 'base', 'meta']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
const RAW_TEXT = new Set(['style', 'textarea', 'xmp']);
const URL_ATTRS = new Set(['href', 'src', 'data', 'poster', 'xlink:href', 'action', 'background', 'cite', 'longdesc', 'formaction', 'srcset']);
const DROP_ATTRS = new Set(['srcdoc', 'formaction', 'action', 'ping', 'http-equiv']);

function escapeText(s: string) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string) {
	return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function unsafeUrl(value: string) {
	const v = value.replace(/[\u0000- ]+/g, '').toLowerCase();
	if (v.startsWith('javascript:') || v.startsWith('vbscript:')) return true;
	if (v.startsWith('data:') && !v.startsWith('data:image/')) return true;
	return false;
}

function typeset(tex: string, display: boolean) {
	try {
		return katex.renderToString(tex, { displayMode: display, throwOnError: false, strict: 'ignore', trust: false, output: 'htmlAndMathml' });
	} catch {
		return `<code>${escapeText(tex)}</code>`;
	}
}

const TEXT_SPECIALS = /\\\(([\s\S]+?)\\\)|\\\[([\s\S]+?)\\\]|\[\$\$\]([\s\S]+?)\[\/\$\$\]|\[\$\]([\s\S]+?)\[\/\$\]|\[latex\]([\s\S]+?)\[\/latex\]|\[sound:([^\]]+)\]|\[anki:tts[^\]]*\]([\s\S]*?)\[\/anki:tts\]/g;

/** Escapes a run of text, turning math, LaTeX, sound and TTS tags into HTML. */
function renderText(text: string, flags: { math: boolean; media: string[] }): string {
	let out = '';
	let last = 0;
	for (const m of text.matchAll(TEXT_SPECIALS)) {
		out += escapeText(text.slice(last, m.index));
		last = m.index + m[0].length;
		if (m[1] !== undefined || m[4] !== undefined) {
			flags.math = true;
			out += typeset((m[1] ?? m[4]).trim(), false);
		} else if (m[2] !== undefined || m[3] !== undefined) {
			flags.math = true;
			out += typeset((m[2] ?? m[3]).trim(), true);
		} else if (m[5] !== undefined) {
			out += `<pre class="latex">${escapeText(m[5].trim())}</pre>`;
		} else if (m[6] !== undefined) {
			const name = m[6].trim();
			flags.media.push(name);
			out += `<audio class="sound" controls preload="none" src="${escapeAttr(name)}"></audio>`;
		} else {
			out += escapeText(m[7] ?? '');
		}
	}
	return out + escapeText(text.slice(last));
}

export interface CleanResult {
	html: string;
	/** Something script-like was removed (a <script>, an onclick=, a javascript: link…). Always false in frame mode. */
	removedScript: boolean;
	/** Whether KaTeX output is present (the frame then loads KaTeX's stylesheet). */
	math: boolean;
}

export function cleanCardHtml(html: string, mode: 'clean' | 'frame' = 'clean'): CleanResult {
	const frame = mode === 'frame';
	const dropWithContent = frame ? FRAME_DROP_WITH_CONTENT : DROP_WITH_CONTENT;
	const dropTagOnly = frame ? FRAME_DROP_TAG_ONLY : DROP_TAG_ONLY;
	let out = '';
	let removedScript = false;
	const flags = { math: false, media: [] as string[] };
	let dropDepth = 0;
	let rawElement: string | null = null;
	let textBuf = '';
	const stack: string[] = [];

	const flush = () => {
		if (!textBuf) return;
		if (!dropDepth) {
			if (rawElement === 'script') out += textBuf;
			else out += rawElement ? textBuf.replace(/<\/(style|textarea|xmp)/gi, '<\\/$1') : renderText(textBuf, flags);
		}
		textBuf = '';
	};

	const parser = new Parser(
		{
			onopentag(name, attribs) {
				flush();
				if (dropDepth || dropWithContent.has(name)) {
					if (name === 'script') removedScript = true;
					if (!VOID.has(name)) dropDepth++;
					return;
				}
				if (dropTagOnly.has(name)) return;
				let tag = `<${name}`;
				for (const [k, v] of Object.entries(attribs)) {
					if (!frame) {
						if (k.startsWith('on')) {
							removedScript = true;
							continue;
						}
						if (DROP_ATTRS.has(k)) continue;
						if (URL_ATTRS.has(k) && unsafeUrl(v)) {
							removedScript ||= /^\s*(java|vb)script:/i.test(v);
							continue;
						}
					}
					tag += v === '' ? ` ${k}` : ` ${k}="${escapeAttr(v)}"`;
				}
				out += tag + '>';
				if (!VOID.has(name)) {
					stack.push(name);
					if (RAW_TEXT.has(name) || (frame && name === 'script')) rawElement = name;
				}
			},
			ontext(text) {
				textBuf += text;
			},
			onclosetag(name) {
				flush();
				if (dropDepth) {
					if (!VOID.has(name)) dropDepth--;
					return;
				}
				if (DROP_TAG_ONLY.has(name) || VOID.has(name)) return;
				const at = stack.lastIndexOf(name);
				if (at === -1) return;
				// Close anything left open inside it, then the element itself.
				for (let i = stack.length - 1; i >= at; i--) out += `</${stack[i]}>`;
				stack.length = at;
				if (rawElement === name) rawElement = null;
			}
		},
		{ decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true, recognizeSelfClosing: true }
	);
	parser.write(html);
	parser.end();
	flush();
	return { html: out, removedScript, math: flags.math };
}

/** True if a template or field contains anything that would run script in Anki. */
export function hasScript(html: string) {
	return /<script\b/i.test(html) || /\son[a-z]+\s*=/i.test(html) || /javascript:/i.test(html);
}

const MEDIA_REFS = [
	/<img\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
	/<(?:audio|video|source|track|embed)\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
	/<object\b[^>]*?\bdata\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi,
	/\[sound:([^\]]+)\]/gi
];

function decodeName(raw: string) {
	const s = raw.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
	try {
		return decodeURIComponent(s);
	} catch {
		return s;
	}
}

/** Local media file names a field refers to (remote URLs and data: images are skipped). */
export function mediaReferences(html: string): string[] {
	const names = new Set<string>();
	for (const re of MEDIA_REFS) {
		for (const m of html.matchAll(re)) {
			const raw = m[1] ?? m[2] ?? m[3] ?? '';
			if (!raw || /^(https?:|data:|\/\/|blob:)/i.test(raw.trim())) continue;
			names.add(decodeName(raw).normalize('NFC'));
		}
	}
	return [...names];
}

function escapeRegex(s: string) {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Points references to renamed media files (name clashes on import) at their new names. */
export function renameMediaReferences(html: string, renames: Map<string, string>): string {
	if (!renames.size) return html;
	let out = html;
	for (const [from, to] of renames) {
		if (!out.includes(from)) continue;
		const re = new RegExp(`((?:src|data)\\s*=\\s*["']?|\\[sound:)${escapeRegex(from)}(?=["'\\s>\\]])`, 'g');
		out = out.replace(re, (_m, prefix: string) => prefix + to);
	}
	return out;
}
