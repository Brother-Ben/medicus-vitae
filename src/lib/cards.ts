// Card content rules shared by the server (search, export) and the browser
// (review, editor preview). Fields are Markdown; cloze deletions use Anki's
// {{c1::answer}} or {{c1::answer::hint}} syntax. Notes imported from Anki
// (kind 'anki') keep their HTML fields and are rendered with their own
// templates on the server (src/lib/server/anki).

export type NoteKind = 'basic' | 'basic_reversed' | 'cloze' | 'anki';

export type OwnNoteKind = Exclude<NoteKind, 'anki'>;

export const NOTE_KINDS: { kind: OwnNoteKind; id: string; label: string; fields: string[] }[] = [
	{ kind: 'basic', id: 'nt-basic', label: 'Basic', fields: ['Front', 'Back'] },
	{ kind: 'basic_reversed', id: 'nt-basic-reversed', label: 'Basic and reversed', fields: ['Front', 'Back'] },
	{ kind: 'cloze', id: 'nt-cloze', label: 'Cloze', fields: ['Text', 'Back Extra'] }
];

export function noteTypeId(kind: OwnNoteKind) {
	return NOTE_KINDS.find((k) => k.kind === kind)!.id;
}

/**
 * 'anki' means: HTML fields rendered through the note type's own templates (in
 * the card frame). That's every type imported from Anki, every card type made
 * here (Flashcards › Card types), and the built-in Image Occlusion type.
 */
export function kindForNoteType(id: string): NoteKind {
	if (id.startsWith('anki-') || id.startsWith('custom-') || id === 'nt-image-occlusion') return 'anki';
	return NOTE_KINDS.find((k) => k.id === id)?.kind ?? 'basic';
}

const ENTITIES: Record<string, string> = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };

/** Plain text from Anki field HTML: tags, scripts, styles and [sound:] tags removed, entities decoded. */
export function htmlToText(html: string): string {
	return html
		.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, ' ')
		.replace(/<br\s*\/?>|<\/(div|p|li|tr|h\d)>/gi, '\n')
		.replace(/<[^>]*>/g, ' ')
		.replace(/\[sound:[^\]]*\]/g, ' ')
		.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (m, e: string) => {
			const k = e.toLowerCase();
			if (k.startsWith('#x')) return String.fromCodePoint(parseInt(k.slice(2), 16) || 32);
			if (k.startsWith('#')) return String.fromCodePoint(Number(k.slice(1)) || 32);
			return ENTITIES[k] ?? m;
		});
}

const INNER_CLOZE = /\{\{c[\d,]+::((?:(?!\{\{c[\d,]+::)[\s\S])*?)(?:::((?:(?!\{\{c[\d,]+::)[\s\S])*?))?\}\}/g;

/** Replaces every (possibly nested) cloze with what `show` returns for its answer. */
function flattenClozes(text: string, show: (answer: string) => string): string {
	let out = text;
	for (let i = 0; i < 12; i++) {
		const next = out.replace(INNER_CLOZE, (_m, answer: string) => show(answer));
		if (next === out) break;
		out = next;
	}
	return out;
}

function ankiFieldValues(fields: Record<string, string>) {
	return Object.values(fields).map((v) => htmlToText(flattenClozes(v ?? '', (a) => a)));
}

const CLOZE_RE = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

/** Distinct cloze numbers used in a text, ascending. */
export function clozeNumbers(text: string): number[] {
	const set = new Set<number>();
	for (const m of text.matchAll(CLOZE_RE)) {
		const n = Number(m[1]);
		if (n >= 1 && n <= 500) set.add(n);
	}
	return [...set].sort((a, b) => a - b);
}

/** Template positions (ords) a note produces. Anki notes bring their own cards. */
export function cardOrds(kind: NoteKind, fields: Record<string, string>): number[] {
	if (kind === 'basic') return [0];
	if (kind === 'basic_reversed') return [0, 1];
	if (kind === 'anki') return [];
	return clozeNumbers(fields['Text'] ?? '').map((n) => n - 1);
}

function escapeHtml(s: string) {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Cloze text for one card. Active deletion shows as [...] (or its hint) on the front. */
export function renderCloze(text: string, n: number, side: 'front' | 'back'): string {
	return text.replace(CLOZE_RE, (_all, num: string, answer: string, hint?: string) => {
		if (Number(num) !== n) return answer;
		if (side === 'front') {
			return `<span class="cloze">[${hint ? escapeHtml(hint) : '…'}]</span>`;
		}
		return `<span class="cloze cloze-answer">${answer}</span>`;
	});
}

export interface CardSides {
	front: string;
	back: string;
}

/** Markdown for the two sides of a card. The back repeats nothing from the front except for cloze. */
export function cardSides(kind: NoteKind, fields: Record<string, string>, ord: number): CardSides {
	if (kind === 'anki') {
		const [first = '', ...rest] = ankiFieldValues(fields).filter((v) => v.trim());
		return { front: first, back: rest.join('\n') };
	}
	if (kind === 'cloze') {
		const n = ord + 1;
		const text = fields['Text'] ?? '';
		const extra = (fields['Back Extra'] ?? '').trim();
		return {
			front: renderCloze(text, n, 'front'),
			back: renderCloze(text, n, 'back') + (extra ? `\n\n---\n\n${extra}` : '')
		};
	}
	const front = fields['Front'] ?? '';
	const back = fields['Back'] ?? '';
	return ord === 1 ? { front: back, back: front } : { front, back };
}

/** Plain text for search and previews. */
export function noteText(kind: NoteKind, fields: Record<string, string>): string {
	if (kind === 'anki') return ankiFieldValues(fields).join('\n').replace(/\s+/g, ' ').trim();
	const parts =
		kind === 'cloze'
			? [(fields['Text'] ?? '').replace(CLOZE_RE, (_a, _n, answer: string) => answer), fields['Back Extra'] ?? '']
			: [fields['Front'] ?? '', fields['Back'] ?? ''];
	return parts
		.join('\n')
		.replace(/<[^>]+>/g, ' ')
		.replace(/[*_`#>]+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
}

/** Text of one Anki field for previews: mask data and image occlusion note ids aren't text. */
function previewText(v: string) {
	if (/image-occlusion:/.test(v) || /^\s*[0-9a-f]{32}-ao-\d+\s*$/i.test(v)) return '';
	return htmlToText(flattenClozes(v ?? '', (a) => `[${a}]`)).replace(/\s+/g, ' ').trim();
}

/** Short label for lists: the question side, trimmed. */
export function notePreview(kind: NoteKind, fields: Record<string, string>, max = 140): string {
	if (kind === 'anki') {
		const values = Object.values(fields);
		const first = values.map((v) => previewText(v ?? '')).find(Boolean) ?? (values.some((v) => /<img/i.test(v ?? '')) ? '(picture card)' : '');
		return first.length > max ? first.slice(0, max - 1) + '…' : first;
	}
	const raw =
		kind === 'cloze'
			? (fields['Text'] ?? '').replace(CLOZE_RE, (_a, _n, answer: string) => `[${answer}]`)
			: (fields['Front'] ?? '');
	const text = raw
		.replace(/<[^>]+>/g, ' ')
		.replace(/[*_`#>]+/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

/** Problems that would make a note produce no usable card. */
export function noteProblem(kind: NoteKind, fields: Record<string, string>): string | null {
	if (kind === 'anki') {
		return Object.values(fields).some((v) => htmlToText(v ?? '').trim() || /<img|\[sound:/i.test(v ?? ''))
			? null
			: 'Every field is empty.';
	}
	if (kind === 'cloze') {
		const text = (fields['Text'] ?? '').trim();
		if (!text) return 'Add the text for the cloze card.';
		if (!clozeNumbers(text).length) return 'Mark at least one deletion, like {{c1::answer}}.';
		return null;
	}
	if (!(fields['Front'] ?? '').trim()) return 'The front of the card is empty.';
	if (!(fields['Back'] ?? '').trim()) return 'The back of the card is empty.';
	return null;
}

export const CONFIDENCE = [
	{ code: 'guess', label: 'Guess' },
	{ code: 'unsure', label: 'Unsure' },
	{ code: 'sure', label: 'Sure' }
] as const;

export type Confidence = (typeof CONFIDENCE)[number]['code'];

export const RATINGS = [
	{ value: 1, label: 'Again' },
	{ value: 2, label: 'Hard' },
	{ value: 3, label: 'Good' },
	{ value: 4, label: 'Easy' }
] as const;

export const STATE_LABELS = ['New', 'Learning', 'Review', 'Relearning'];
