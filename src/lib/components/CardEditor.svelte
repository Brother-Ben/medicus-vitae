<script lang="ts" module>
	import type { NoteKind } from '#lib/cards.js';
	import type { AnchorInputClient } from '#lib/reader/anchors.js';

	export interface CardDraft {
		kind: NoteKind;
		fields: Record<string, string>;
		aamcCode: string | null;
		tags: string[];
		/** Notes imported from Anki: their own fields, in order, and note type name. */
		fieldNames?: string[] | null;
		noteTypeName?: string | null;
		/** Card types with their own templates (made here, from Anki, image occlusion). */
		noteTypeId?: string | null;
		noteTypeSource?: string | null;
	}

	export interface CardContext {
		passage: string;
		label: string;
		available?: boolean;
	}
</script>

<script lang="ts">
	import { api } from '#lib/client/api.js';
	import { toast } from '#lib/client/toast.svelte.js';
	import { NOTE_KINDS, noteProblem } from '#lib/cards.js';
	import { renderCardSide } from '#lib/markdown.js';
	import CategorySelect from './CategorySelect.svelte';
	import Icon from './Icon.svelte';
	import Modal from './Modal.svelte';
	import OcclusionEditor from './OcclusionEditor.svelte';
	import { untrack } from 'svelte';

	let {
		open = $bindable(false),
		draft,
		context = null,
		anchor = null,
		anchorId = null,
		noteId = null,
		onsaved
	}: {
		open?: boolean;
		draft: CardDraft;
		context?: CardContext | null;
		anchor?: AnchorInputClient | null;
		anchorId?: string | null;
		noteId?: string | null;
		onsaved?: (result: { noteId: string }) => void;
	} = $props();

	let kind = $state<NoteKind>('basic');
	let front = $state('');
	let back = $state('');
	let text = $state('');
	let extra = $state('');
	let aamcCode = $state<string | null>(null);
	let tags = $state('');
	let preview = $state(false);
	let saving = $state(false);
	let error = $state('');
	let clozeArea: HTMLTextAreaElement | undefined = $state();
	let ankiFields = $state<Record<string, string>>({});
	let ankiNames = $state<string[]>([]);
	// A card type with its own templates, chosen for a new card (or the note's own type).
	let typeId = $state<string | null>(null);
	let typeName = $state<string | null>(null);
	let customTypes = $state<{ id: string; name: string; kind: string; fields: string[]; source: string }[]>([]);
	let ioOpen = $state(false);
	const isIo = $derived(kind === 'anki' && ankiNames.includes('Occlusion') && ankiNames.includes('Image'));

	// Fetched once per editor. A plain flag, not state: the open effect below must not
	// depend on the list, or every fetch would reset the draft and fetch again.
	let typesRequested = false;
	async function loadTypes() {
		if (typesRequested) return;
		typesRequested = true;
		try {
			const r = await api<{ types: { id: string; name: string; kind: string; fields: string[]; source: string }[] }>('/api/note-types');
			customTypes = r.types.filter((t) => t.source === 'custom');
		} catch {
			typesRequested = false;
		}
	}

	function pickType(value: string) {
		if (value === 'io') {
			open = false;
			ioOpen = true;
			return;
		}
		const t = customTypes.find((x) => x.id === value);
		if (!t) return;
		kind = 'anki';
		typeId = t.id;
		typeName = t.name;
		ankiNames = t.fields;
		ankiFields = Object.fromEntries(t.fields.map((n) => [n, '']));
	}

	// Load the draft each time the editor opens.
	$effect(() => {
		if (!open) return;
		kind = draft.kind;
		front = draft.fields['Front'] ?? '';
		back = draft.fields['Back'] ?? '';
		text = draft.fields['Text'] ?? '';
		extra = draft.fields['Back Extra'] ?? '';
		// Local first: reading state this effect just wrote would make it re-run forever.
		const names = draft.fieldNames ?? Object.keys(draft.fields);
		ankiNames = names;
		ankiFields = Object.fromEntries(names.map((n) => [n, draft.fields[n] ?? '']));
		typeId = draft.noteTypeId ?? null;
		typeName = draft.noteTypeName ?? null;
		aamcCode = draft.aamcCode;
		tags = draft.tags.join(' ');
		preview = false;
		error = '';
		if (!noteId) untrack(() => void loadTypes());
	});

	const fields = $derived.by((): Record<string, string> =>
		kind === 'anki' ? { ...ankiFields } : kind === 'cloze' ? { Text: text, 'Back Extra': extra } : { Front: front, Back: back }
	);
	const problem = $derived(noteProblem(kind, fields));
	const editing = $derived(!!noteId);

	function switchKind(k: NoteKind) {
		if (k === kind) return;
		// Carry the passage over so switching types doesn't lose text.
		if (k === 'cloze' && !text.trim()) text = back || front;
		if (k !== 'cloze' && kind === 'cloze' && !back.trim()) back = text.replace(/\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g, '$1');
		kind = k;
	}

	function makeCloze(sameNumber = false) {
		const el = clozeArea;
		if (!el) return;
		const start = el.selectionStart;
		const end = el.selectionEnd;
		const used = [...text.matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1]));
		const n = used.length ? (sameNumber ? Math.max(...used) : Math.max(...used) + 1) : 1;
		const selected = text.slice(start, end) || 'answer';
		text = `${text.slice(0, start)}{{c${n}::${selected}}}${text.slice(end)}`;
		queueMicrotask(() => {
			el.focus();
			const pos = start + `{{c${n}::`.length;
			el.setSelectionRange(pos, pos + selected.length);
		});
	}

	async function save() {
		if (problem) {
			error = problem;
			return;
		}
		saving = true;
		error = '';
		const note = {
			kind,
			fields,
			aamcCode,
			tags: tags.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean)
		};
		try {
			if (editing) {
				await api('/api/cards', { method: 'PATCH', body: { noteId, note } });
				toast('Card saved');
				onsaved?.({ noteId: noteId! });
			} else if (kind === 'anki' && typeId) {
				const r = await api<{ noteId: string; cardIds: string[] }>('/api/cards', {
					body: { templated: { noteTypeId: typeId, fields, aamcCode, tags: note.tags }, anchor, anchorId }
				});
				toast(r.cardIds.length > 1 ? `${r.cardIds.length} cards created` : 'Card created');
				onsaved?.({ noteId: r.noteId });
			} else {
				const r = await api<{ noteId: string; cardIds: string[] }>('/api/cards', { body: { note, anchor, anchorId } });
				toast(r.cardIds.length > 1 ? `${r.cardIds.length} cards created` : 'Card created');
				onsaved?.({ noteId: r.noteId });
			}
			open = false;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
			e.preventDefault();
			void save();
		}
		if (kind === 'cloze' && (e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'C' || e.key === 'c')) {
			e.preventDefault();
			makeCloze(e.altKey);
		}
	}
</script>

<Modal bind:open title={editing ? 'Edit card' : 'New card'} wide>
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="stack" onkeydown={onKey}>
		{#if context}
			<div class="context">
				<div class="row" style="justify-content: space-between">
					<span class="tiny muted strong" style="text-transform: uppercase; letter-spacing: 0.06em">From the passage</span>
					<span class="source-chip" class:missing={context.available === false}>
						<Icon name="book" size={13} stroke={2} />{context.available === false ? 'Source missing · ' : ''}{context.label}
					</span>
				</div>
				{#if context.passage}<blockquote class="reading">{context.passage}</blockquote>{/if}
			</div>
		{/if}

		{#if !editing}
			<div class="row-tight">
				<div class="segmented" role="tablist" aria-label="Card type">
					{#each NOTE_KINDS as k (k.kind)}
						<button
							type="button"
							role="tab"
							aria-selected={kind === k.kind}
							onclick={() => {
								typeId = null;
								switchKind(k.kind);
							}}>{k.label}</button
						>
					{/each}
				</div>
				<label class="sr-only" for="more-types">More card types</label>
				<select id="more-types" class="select input-sm more-types" value={kind === 'anki' && typeId ? typeId : ''} onchange={(e) => pickType((e.currentTarget as HTMLSelectElement).value)}>
					<option value="">More types…</option>
					<option value="io">Image occlusion</option>
					{#each customTypes as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
				</select>
				<a class="small" href="/cards/types">Card types</a>
			</div>
		{/if}

		{#if kind === 'anki'}
			<div class="notice">
				<Icon name="cards" size={16} />
				<div>
					{#if draft.noteTypeSource === 'anki' || (editing && !draft.noteTypeSource)}
						From Anki{draft.noteTypeName ? ` · ${draft.noteTypeName}` : ''}. Fields are HTML, as in Anki. If you change this note, a later import of the same deck asks before replacing your version.
					{:else}
						{typeName ?? draft.noteTypeName ?? 'Card type'} · fields are HTML; the card type’s templates lay them out. <a href="/cards/types{typeId ? `/${typeId}` : ''}">Edit the card type</a>
					{/if}
				</div>
			</div>
			{#if isIo}
				<div class="row-tight">
					<button
						type="button"
						class="btn btn-sm"
						onclick={() => {
							open = false;
							ioOpen = true;
						}}><Icon name="image" size={15} />Edit masks</button
					>
					<span class="small muted">Draw, move and group the boxes over the image.</span>
				</div>
			{/if}
			{#each ankiNames as name, i (name)}
				<div class="field">
					<label for="anki-field-{i}">{name}</label>
					<textarea id="anki-field-{i}" class="textarea mono-area" rows={i === 0 ? 4 : 3} bind:value={ankiFields[name]}></textarea>
				</div>
			{/each}
		{:else if preview}
			<div class="preview-grid">
				{#each kind === 'basic_reversed' ? [0, 1] : kind === 'cloze' ? [...new Set([...text.matchAll(/\{\{c(\d+)::/g)].map((m) => Number(m[1]) - 1))].sort((a, b) => a - b) : [0] as ord (ord)}
					<div class="preview-card">
						<div class="tiny muted strong">Card {ord + 1} · front</div>
						<div class="md card-text">{@html renderCardSide(kind, fields, ord, 'front')}</div>
						<hr />
						<div class="tiny muted strong">Back</div>
						<div class="md card-text">{@html renderCardSide(kind, fields, ord, 'back')}</div>
					</div>
				{/each}
			</div>
		{:else if kind === 'cloze'}
			<div class="field">
				<div class="row" style="justify-content: space-between">
					<label for="cloze-text">Text</label>
					<div class="row-tight">
						<button type="button" class="btn btn-sm" onclick={() => makeCloze(false)} title="Ctrl+Shift+C">Make cloze</button>
						<button type="button" class="btn btn-sm btn-ghost" onclick={() => makeCloze(true)} title="Ctrl+Shift+Alt+C">Same card</button>
					</div>
				</div>
				<textarea id="cloze-text" class="textarea" rows="5" bind:value={text} bind:this={clozeArea}></textarea>
				<span class="hint">Select words and press Make cloze. Each number becomes its own card; “Same card” hides several parts on one card.</span>
			</div>
			<div class="field">
				<label for="cloze-extra">Back extra <span class="muted">(optional)</span></label>
				<textarea id="cloze-extra" class="textarea" rows="2" bind:value={extra}></textarea>
			</div>
		{:else}
			<div class="field">
				<label for="card-front">{kind === 'basic_reversed' ? 'Side 1' : 'Front (question)'}</label>
				<!-- svelte-ignore a11y_autofocus -->
				<textarea id="card-front" class="textarea" rows="3" bind:value={front} autofocus placeholder="What should you be able to recall?"></textarea>
			</div>
			<div class="field">
				<label for="card-back">{kind === 'basic_reversed' ? 'Side 2' : 'Back (answer)'}</label>
				<textarea id="card-back" class="textarea" rows="4" bind:value={back}></textarea>
			</div>
		{/if}

		<div class="form-grid">
			<div class="field">
				<label for="card-cat">AAMC category</label>
				<CategorySelect id="card-cat" bind:value={aamcCode} />
			</div>
			<div class="field">
				<label for="card-tags">Tags <span class="muted">(optional)</span></label>
				<input id="card-tags" class="input" bind:value={tags} placeholder="enzymes kinetics" />
			</div>
		</div>
		<p class="hint">{kind === 'anki' ? 'Ctrl+Enter saves.' : 'Markdown works: **bold**, *italic*, lists. Ctrl+Enter saves.'}</p>
		{#if error}<div class="error-box" role="alert"><Icon name="alert" size={18} />{error}</div>{/if}
	</div>
	{#snippet footer()}
		{#if kind !== 'anki'}
			<button type="button" class="btn btn-ghost" onclick={() => (preview = !preview)}>
				<Icon name="eye" size={18} />{preview ? 'Edit' : 'Preview'}
			</button>
		{/if}
		<span class="spacer"></span>
		<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" disabled={saving} onclick={save}>{saving ? 'Saving…' : editing ? 'Save card' : 'Create card'}</button>
	{/snippet}
</Modal>

<OcclusionEditor
	bind:open={ioOpen}
	noteId={editing && isIo ? noteId : null}
	noteTypeId={editing && isIo ? (typeId ?? 'nt-image-occlusion') : 'nt-image-occlusion'}
	fields={editing && isIo ? { ...ankiFields } : null}
	tags={tags.split(/[\s,]+/).filter(Boolean)}
	{aamcCode}
	onsaved={() => onsaved?.({ noteId: noteId ?? '' })}
/>

<style>
	.context {
		background: var(--surface-2);
		border-radius: var(--radius);
		padding: 0.875rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.context blockquote {
		margin: 0;
		font-size: 0.9375rem;
		color: var(--text);
		max-height: 9rem;
		overflow-y: auto;
	}
	.preview-grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 1rem;
	}
	.preview-card {
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		padding: 1rem;
	}
	.card-text {
		font-size: 1rem;
		margin-top: 0.375rem;
	}
	.mono-area {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
	}
	.more-types {
		width: auto;
	}
</style>
