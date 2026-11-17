import { and, eq, isNull } from 'drizzle-orm';
import { kindForNoteType } from '../cards';
import { complete } from './ai/providers';
import { clozeNumbersIn } from './anki/cloze';
import { renderAnkiCard } from './anki/template';
import { db, inTx, sqlite } from './db';
import { card, note, noteType, tombstone } from './db/schema';
import { emptyState } from './fsrs';
import { uuidv7 } from './ids';

// Card types made here (Flashcards › Card types): fields, front and back
// templates, styling and scripts, the way Anki's note types work. They render
// with Anki's template rules in the sealed card frame (scripts run there and
// nowhere else). Also the built-in Image Occlusion type, in Anki's own format,
// so masks drawn here work in Anki too.

export class NoteTypeError extends Error {}

export const IO_TYPE_ID = 'nt-image-occlusion';
export const IO_FIELDS = ['Occlusion', 'Image', 'Header', 'Back Extra', 'Comments'];

/** Anki's stock image occlusion templates (Anki 23.10+). */
const IO_FRONT =
	'{{#Header}}<div>{{Header}}</div>{{/Header}}\n<div style="display: none">{{cloze:Occlusion}}</div>\n<div id="err"></div>\n<div id="image-occlusion-container">\n    {{Image}}\n    <canvas id="image-occlusion-canvas"></canvas>\n</div>\n<script>\ntry {\n    anki.imageOcclusion.setup();\n} catch (exc) {\n    document.getElementById("err").innerHTML = `Error loading image occlusion. Is your Anki version up to date?<br><br>${exc}`;\n}\n</script>';
const IO_BACK = IO_FRONT + '\n<div><button id="toggle">Toggle Masks</button></div>\n{{#Back Extra}}<div>{{Back Extra}}</div>{{/Back Extra}}';
const IO_CSS = `#image-occlusion-canvas {
  --inactive-shape-color: #ffeba2;
  --active-shape-color: #ff8e8e;
  --inactive-shape-border: 1px #212121;
  --active-shape-border: 1px #212121;
  --highlight-shape-color: #ff8e8e00;
  --highlight-shape-border: 1px #ff8e8e;
}
#image-occlusion-container img { max-width: 100%; height: auto; }
.card { text-align: center; }
#toggle { margin-top: 0.75rem; font: inherit; padding: 0.25rem 0.75rem; border-radius: 6px; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; }`;

/** The built-in Image Occlusion card type, created the first time it's needed. */
export function ensureImageOcclusionType() {
	const now = Date.now();
	db()
		.insert(noteType)
		.values({
			id: IO_TYPE_ID,
			name: 'Image Occlusion',
			kind: 'anki_cloze',
			fields: IO_FIELDS,
			templates: [{ name: 'Image Occlusion', front: IO_FRONT, back: IO_BACK }],
			builtin: true,
			css: IO_CSS,
			source: 'builtin',
			sortField: 2,
			createdAt: now,
			updatedAt: now
		})
		.onConflictDoNothing()
		.run();
	return IO_TYPE_ID;
}

/** The built-in kinds as Anki templates (for "Duplicate to edit"). */
const BUILTIN_SHAPES: Record<string, { kind: 'anki_standard' | 'anki_cloze'; fields: string[]; templates: { name: string; front: string; back: string }[] }> = {
	'nt-basic': { kind: 'anki_standard', fields: ['Front', 'Back'], templates: [{ name: 'Card 1', front: '{{Front}}', back: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' }] },
	'nt-basic-reversed': {
		kind: 'anki_standard',
		fields: ['Front', 'Back'],
		templates: [
			{ name: 'Card 1', front: '{{Front}}', back: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' },
			{ name: 'Card 2', front: '{{Back}}', back: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Front}}' }
		]
	},
	'nt-cloze': { kind: 'anki_cloze', fields: ['Text', 'Back Extra'], templates: [{ name: 'Cloze', front: '{{cloze:Text}}', back: '{{cloze:Text}}<br>\n{{Back Extra}}' }] }
};

export interface NoteTypeInput {
	name: string;
	kind: 'standard' | 'cloze';
	fields: string[];
	templates: { name: string; front: string; back: string }[];
	css: string;
	/** Renamed fields, old name → new name, so existing cards keep their content. */
	renames?: Record<string, string>;
}

export interface NoteTypeView {
	id: string;
	name: string;
	kind: 'standard' | 'cloze';
	fields: string[];
	templates: { name: string; front: string; back: string }[];
	css: string;
	source: string;
	editable: boolean;
	notes: number;
	scripts: boolean;
	updatedAt: number | null;
}

function toView(t: typeof noteType.$inferSelect, notes: number): NoteTypeView {
	const isBuiltinSimple = t.id in BUILTIN_SHAPES;
	const shape = isBuiltinSimple ? BUILTIN_SHAPES[t.id] : null;
	const templates = shape ? shape.templates : t.templates;
	return {
		id: t.id,
		name: t.name,
		kind: (shape?.kind ?? t.kind) === 'anki_cloze' || t.kind === 'cloze' ? 'cloze' : 'standard',
		fields: shape ? shape.fields : t.fields,
		templates,
		css: t.css,
		source: t.source,
		editable: t.source === 'custom',
		notes,
		scripts: templates.some((x) => /<script/i.test(x.front + x.back)),
		updatedAt: t.updatedAt
	};
}

export function listNoteTypes(): NoteTypeView[] {
	const counts = new Map(
		(sqlite().prepare('SELECT note_type_id AS id, count(*) AS n FROM note WHERE deleted_at IS NULL GROUP BY note_type_id').all() as { id: string; n: number }[]).map((r) => [r.id, r.n])
	);
	const order = (t: typeof noteType.$inferSelect) => (t.source === 'builtin' ? 0 : t.source === 'custom' ? 1 : 2);
	return db()
		.select()
		.from(noteType)
		.all()
		.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name))
		.map((t) => toView(t, counts.get(t.id) ?? 0));
}

export function getNoteTypeView(id: string): NoteTypeView | null {
	if (id === IO_TYPE_ID) ensureImageOcclusionType();
	const t = db().select().from(noteType).where(eq(noteType.id, id)).get();
	if (!t) return null;
	const n = (sqlite().prepare('SELECT count(*) AS n FROM note WHERE deleted_at IS NULL AND note_type_id = ?').get(id) as { n: number }).n;
	return toView(t, n);
}

function clean(input: NoteTypeInput) {
	const name = String(input.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
	if (!name) throw new NoteTypeError('Give the card type a name.');
	const fields = (input.fields ?? []).map((f) => String(f).replace(/[{}:#^/"]/g, '').trim().slice(0, 60)).filter(Boolean);
	if (!fields.length) throw new NoteTypeError('Add at least one field.');
	if (new Set(fields.map((f) => f.toLowerCase())).size !== fields.length) throw new NoteTypeError('Two fields have the same name.');
	const kind = input.kind === 'cloze' ? 'cloze' : 'standard';
	let templates = (input.templates ?? []).map((t, i) => ({ name: String(t.name ?? '').trim().slice(0, 60) || `Card ${i + 1}`, front: String(t.front ?? '').slice(0, 100_000), back: String(t.back ?? '').slice(0, 100_000) }));
	if (kind === 'cloze') templates = templates.slice(0, 1);
	if (!templates.length) throw new NoteTypeError('Add a card template.');
	if (templates.some((t) => !t.front.trim())) throw new NoteTypeError('Every card template needs a front.');
	if (kind === 'cloze' && !/\{\{(?:[^}]*:)?cloze:/i.test(templates[0].front)) throw new NoteTypeError('A cloze card type’s front needs a {{cloze:Field}}.');
	// Check the templates parse (a sample render surfaces template errors).
	for (let i = 0; i < templates.length; i++) {
		const sample = Object.fromEntries(fields.map((f) => [f, kind === 'cloze' ? '{{c1::sample}}' : 'sample']));
		const r = renderAnkiCard({ name, kind: kind === 'cloze' ? 'cloze' : 'standard', fields, templates }, sample, i, { tags: [], deck: null });
		const problem = /<div class="card-problem">([^<]*)<\/div>/.exec(r.question)?.[1];
		if (problem && /template problem/i.test(problem)) throw new NoteTypeError(`${templates[i].name}: ${problem.replace(/^Card template problem: /, '')}`);
	}
	return { name, kind, fields, templates, css: String(input.css ?? '').slice(0, 200_000) };
}

export function createNoteType(input: NoteTypeInput): string {
	const v = clean(input);
	const id = `custom-${uuidv7()}`;
	const now = Date.now();
	db()
		.insert(noteType)
		.values({ id, name: v.name, kind: v.kind === 'cloze' ? 'anki_cloze' : 'anki_standard', fields: v.fields, templates: v.templates, css: v.css, builtin: false, source: 'custom', sortField: 0, createdAt: now, updatedAt: now })
		.run();
	return id;
}

export function updateNoteType(id: string, input: NoteTypeInput) {
	const t = db().select().from(noteType).where(eq(noteType.id, id)).get();
	if (!t) throw new NoteTypeError('Card type not found.');
	if (t.source !== 'custom') throw new NoteTypeError('Only card types made here can be changed. Duplicate this one to edit a copy.');
	const v = clean(input);
	const wasCloze = t.kind === 'anki_cloze';
	const notes = sqlite().prepare('SELECT count(*) AS n FROM note WHERE deleted_at IS NULL AND note_type_id = ?').get(id) as { n: number };
	if (notes.n && wasCloze !== (v.kind === 'cloze')) throw new NoteTypeError('Cards already use this type, so it can’t switch between standard and cloze. Make a new type instead.');
	const renames = Object.entries(input.renames ?? {}).filter(([a, b]) => a && b && a !== b && v.fields.includes(b));
	inTx(() => {
		db()
			.update(noteType)
			.set({ name: v.name, kind: v.kind === 'cloze' ? 'anki_cloze' : 'anki_standard', fields: v.fields, templates: v.templates, css: v.css, updatedAt: Date.now() })
			.where(eq(noteType.id, id))
			.run();
		if (renames.length) {
			for (const n of db().select().from(note).where(and(eq(note.noteTypeId, id), isNull(note.deletedAt))).all()) {
				const f = { ...n.fields };
				for (const [from, to] of renames) {
					if (from in f) {
						f[to] = f[from];
						delete f[from];
					}
				}
				db().update(note).set({ fields: f, rev: n.rev + 1, updatedAt: Date.now() }).where(eq(note.id, n.id)).run();
			}
		}
		syncCards(id);
	});
}

/** After templates changed: each note gets a card for every template that shows something, and loses the rest. */
export function syncCards(typeId: string) {
	const t = db().select().from(noteType).where(eq(noteType.id, typeId)).get();
	if (!t) return { added: 0, removed: 0 };
	const shape = { name: t.name, kind: t.kind === 'anki_cloze' ? ('cloze' as const) : ('standard' as const), fields: t.fields, templates: t.templates };
	let added = 0;
	let removed = 0;
	const now = Date.now();
	for (const n of db().select().from(note).where(and(eq(note.noteTypeId, typeId), isNull(note.deletedAt))).all()) {
		const wanted = new Set(cardOrdsFor(shape, n.fields, n.tags));
		const existing = db().select().from(card).where(and(eq(card.noteId, n.id), isNull(card.deletedAt))).all();
		const have = new Set(existing.map((c) => c.ord));
		const deck = existing.find((c) => c.deck)?.deck ?? null;
		for (const ord of wanted) {
			if (have.has(ord)) continue;
			db().insert(card).values({ id: uuidv7(), noteId: n.id, ord, ...emptyState(now), rev: 0, deck, createdAt: now, updatedAt: now }).run();
			added++;
		}
		for (const c of existing) {
			if (wanted.has(c.ord) || !wanted.size) continue;
			db().update(card).set({ deletedAt: now, updatedAt: now }).where(eq(card.id, c.id)).run();
			db().insert(tombstone).values({ id: uuidv7(), recordType: 'card', recordId: c.id, deletedAt: now }).run();
			removed++;
		}
	}
	return { added, removed };
}

/** Which cards (template positions) a note of this type makes: cloze numbers, or templates whose front shows something. */
export function cardOrdsFor(shape: { name: string; kind: 'standard' | 'cloze'; fields: string[]; templates: { name: string; front: string; back: string }[] }, fields: Record<string, string>, tags: string[] = []): number[] {
	if (shape.kind === 'cloze') {
		const nums = new Set<number>();
		for (const name of shape.fields) for (const n of clozeNumbersIn(fields[name] ?? '')) nums.add(n);
		return [...nums].sort((a, b) => a - b).map((n) => n - 1);
	}
	const out: number[] = [];
	shape.templates.forEach((_t, i) => {
		const r = renderAnkiCard(shape, fields, i, { tags, deck: null });
		if (!r.empty) out.push(i);
	});
	return out;
}

/** A copy that can be edited (of a built-in, an imported Anki type, or another one made here). */
export function duplicateNoteType(id: string, name?: string): string {
	const t = id === IO_TYPE_ID ? (ensureImageOcclusionType(), db().select().from(noteType).where(eq(noteType.id, id)).get()) : db().select().from(noteType).where(eq(noteType.id, id)).get();
	if (!t) throw new NoteTypeError('Card type not found.');
	const shape = BUILTIN_SHAPES[t.id];
	return createNoteType({
		name: name?.trim() || `${t.name} (copy)`,
		kind: (shape?.kind ?? t.kind) === 'anki_cloze' ? 'cloze' : 'standard',
		fields: shape?.fields ?? t.fields,
		templates: shape?.templates ?? t.templates,
		css: t.css || '.card { font-family: system-ui, sans-serif; font-size: 20px; text-align: center; }'
	});
}

export function deleteNoteType(id: string) {
	const t = db().select().from(noteType).where(eq(noteType.id, id)).get();
	if (!t) return;
	if (t.source !== 'custom') throw new NoteTypeError('Only card types made here can be deleted.');
	const n = (sqlite().prepare('SELECT count(*) AS n FROM note WHERE note_type_id = ?').get(id) as { n: number }).n;
	if (n) throw new NoteTypeError('Cards still use this type (including deleted ones kept for Undo). Delete those cards first, or keep the type.');
	db().delete(noteType).where(eq(noteType.id, id)).run();
}

/** Both sides of one card of a (possibly unsaved) card type, for the editor's live preview. */
export function previewCard(def: { name: string; kind: 'standard' | 'cloze'; fields: string[]; templates: { name: string; front: string; back: string }[] }, sample: Record<string, string>, ord: number) {
	const shape = { name: def.name || 'Preview', kind: def.kind, fields: def.fields, templates: def.templates.length ? def.templates : [{ name: 'Card 1', front: '', back: '' }] };
	const r = renderAnkiCard(shape, sample, Math.max(0, ord), { tags: ['preview'], deck: 'Preview' });
	return { front: r.question, back: r.answer, math: r.math, empty: r.empty };
}

export function isTemplatedType(id: string) {
	return kindForNoteType(id) === 'anki';
}

// ---------------------------------------------------------------- AI help

const AI_SCHEMA = {
	type: 'object',
	properties: {
		name: { type: 'string' },
		kind: { type: 'string', enum: ['standard', 'cloze'] },
		fields: { type: 'array', items: { type: 'string' } },
		templates: {
			type: 'array',
			items: {
				type: 'object',
				properties: { name: { type: 'string' }, front: { type: 'string' }, back: { type: 'string' } },
				required: ['name', 'front', 'back'],
				additionalProperties: false
			}
		},
		css: { type: 'string' },
		sample: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, value: { type: 'string' } }, required: ['field', 'value'], additionalProperties: false } },
		notes: { type: 'string' }
	},
	required: ['name', 'kind', 'fields', 'templates', 'css', 'sample', 'notes'],
	additionalProperties: false
} as const;

/** Writes (or changes) a card type from a description: fields, templates with any scripts, and styling. */
export async function aiDesignNoteType(description: string, current?: Partial<NoteTypeInput> | null) {
	const ask = String(description ?? '').trim().slice(0, 4000);
	if (!ask) throw new NoteTypeError('Describe the card type you want.');
	const res = await complete({
		feature: 'generate',
		effort: 'medium',
		maxTokens: 16000,
		schema: AI_SCHEMA as unknown as Record<string, unknown>,
		system: `You design Anki note types (card types) for an MCAT student's flashcard app that renders cards exactly like Anki: Anki's template syntax ({{Field}}, {{#Field}}…{{/Field}}, {{^Field}}…{{/Field}}, {{FrontSide}}, {{cloze:Field}}, {{hint:Field}}, {{text:Field}}, {{type:Field}}), the card's CSS, and plain JavaScript in <script> tags inside the templates.
Rules:
- The card runs in a sandboxed frame with no network access: no external scripts, fonts or images, no fetch. Use plain DOM APIs; scripts run on every card render, so make them idempotent. Persist small state only with localStorage if needed.
- Keep markup accessible (buttons are <button>, readable contrast); don't set the card's background or text colors unless the user asks, so it follows the app's light and dark themes.
- kind "cloze" needs exactly one template whose front uses {{cloze:SomeField}}; "standard" can have several templates (one card each).
- Back templates usually start with {{FrontSide}} and <hr id=answer>.
- Give "sample" values for each field so the preview shows something sensible; "notes" is one or two sentences on how to use the type.`,
		messages: [
			{
				role: 'user',
				content: current?.templates?.length
					? `Change this card type as asked.\n\nRequest: ${ask}\n\nCurrent type:\n${JSON.stringify({ name: current.name, kind: current.kind, fields: current.fields, templates: current.templates, css: current.css })}`
					: `Make a card type for this: ${ask}`
			}
		]
	});
	const j = (res.json ?? {}) as { name?: string; kind?: string; fields?: string[]; templates?: { name: string; front: string; back: string }[]; css?: string; sample?: { field: string; value: string }[]; notes?: string };
	return {
		name: String(j.name ?? '').slice(0, 100),
		kind: j.kind === 'cloze' ? ('cloze' as const) : ('standard' as const),
		fields: (j.fields ?? []).map(String).slice(0, 30),
		templates: (j.templates ?? []).map((t) => ({ name: String(t.name ?? ''), front: String(t.front ?? ''), back: String(t.back ?? '') })).slice(0, 10),
		css: String(j.css ?? ''),
		sample: Object.fromEntries((j.sample ?? []).map((s) => [String(s.field), String(s.value)])),
		notes: String(j.notes ?? '')
	};
}
