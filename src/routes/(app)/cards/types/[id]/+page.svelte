<script lang="ts">
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	import AnkiCard from '#lib/components/AnkiCard.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { api } from '#lib/client/api.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	interface FieldRow {
		original: string | null;
		name: string;
	}
	interface Tpl {
		name: string;
		front: string;
		back: string;
	}

	let name = $state('');
	let kind = $state<'standard' | 'cloze'>('standard');
	let fields = $state<FieldRow[]>([]);
	let templates = $state<Tpl[]>([]);
	let css = $state('');
	let sample = $state<Record<string, string>>({});
	let tplIndex = $state(0);
	let side = $state<'front' | 'back' | 'css'>('front');
	let saving = $state(false);
	let error = $state('');
	let aiAsk = $state('');
	let aiBusy = $state(false);
	let aiNotes = $state('');
	let dirty = $state(false);

	const editable = $derived(data.isNew || !!data.type?.editable);
	const BASIC_CSS = '.card {\n  font-family: system-ui, sans-serif;\n  font-size: 20px;\n  text-align: center;\n}\n';

	function load() {
		const t = data.type;
		if (t) {
			name = t.name;
			kind = t.kind;
			fields = t.fields.map((f) => ({ original: f, name: f }));
			templates = t.templates.map((x) => ({ ...x }));
			css = t.css;
		} else {
			name = '';
			kind = 'standard';
			fields = [
				{ original: null, name: 'Front' },
				{ original: null, name: 'Back' }
			];
			templates = [{ name: 'Card 1', front: '{{Front}}', back: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' }];
			css = BASIC_CSS;
		}
		sample = Object.fromEntries(fields.map((f) => [f.name, kind === 'cloze' ? `Sample with a {{c1::deletion}}` : `Sample ${f.name.toLowerCase()}`]));
		tplIndex = 0;
		dirty = false;
	}

	onMount(() => {
		load();
		if (data.startWithAi) document.getElementById('ai-ask')?.focus();
	});

	const def = $derived({ name, kind, fields: fields.map((f) => f.name.trim()).filter(Boolean), templates: kind === 'cloze' ? templates.slice(0, 1) : templates, css });

	// Live preview, a moment after each change.
	let preview = $state<{ front: string; back: string; math: boolean; empty: boolean; mediaBase: string } | null>(null);
	let pTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		const body = { action: 'preview', type: $state.snapshot(def), sample: $state.snapshot(sample), ord: kind === 'cloze' ? 0 : tplIndex };
		if (pTimer) clearTimeout(pTimer);
		pTimer = setTimeout(async () => {
			try {
				preview = await api('/api/note-types', { body });
			} catch {
				preview = null;
			}
		}, 300);
	});

	function mark() {
		dirty = true;
	}

	function addField() {
		let n = fields.length + 1;
		while (fields.some((f) => f.name === `Field ${n}`)) n++;
		fields = [...fields, { original: null, name: `Field ${n}` }];
		sample[`Field ${n}`] = '';
		mark();
	}

	function removeField(i: number) {
		fields = fields.filter((_f, k) => k !== i);
		mark();
	}

	function moveField(i: number, d: -1 | 1) {
		const j = i + d;
		if (j < 0 || j >= fields.length) return;
		const next = [...fields];
		[next[i], next[j]] = [next[j], next[i]];
		fields = next;
		mark();
	}

	function addTemplate() {
		const first = def.fields[0] ?? 'Front';
		templates = [...templates, { name: `Card ${templates.length + 1}`, front: `{{${def.fields[1] ?? first}}}`, back: `{{FrontSide}}\n\n<hr id=answer>\n\n{{${first}}}` }];
		tplIndex = templates.length - 1;
		mark();
	}

	function removeTemplate(i: number) {
		if (templates.length < 2) return;
		templates = templates.filter((_t, k) => k !== i);
		tplIndex = Math.max(0, Math.min(tplIndex, templates.length - 1));
		mark();
	}

	function insertField(f: string) {
		const ta = document.getElementById('tpl-editor') as HTMLTextAreaElement | null;
		const tag = kind === 'cloze' && side === 'front' ? `{{cloze:${f}}}` : `{{${f}}}`;
		const t = templates[tplIndex];
		if (!t || side === 'css') return;
		const cur = t[side];
		const at = ta ? ta.selectionStart : cur.length;
		t[side] = cur.slice(0, at) + tag + cur.slice(ta ? ta.selectionEnd : cur.length);
		mark();
		queueMicrotask(() => {
			ta?.focus();
			ta?.setSelectionRange(at + tag.length, at + tag.length);
		});
	}

	async function askAi() {
		aiBusy = true;
		error = '';
		try {
			const r = await api<{ design: { name: string; kind: 'standard' | 'cloze'; fields: string[]; templates: Tpl[]; css: string; sample: Record<string, string>; notes: string } }>('/api/note-types', {
				body: { action: 'ai', description: aiAsk, current: dirty || data.type ? $state.snapshot(def) : null }
			});
			const d = r.design;
			if (!d.templates.length || !d.fields.length) throw new Error('The AI didn’t come back with a usable card type. Try describing it differently.');
			name = d.name || name || 'New card type';
			kind = d.kind;
			// Keep the link between old and new names where a field kept its name.
			fields = d.fields.map((f) => ({ original: fields.find((x) => x.original === f)?.original ?? null, name: f }));
			templates = d.templates;
			css = d.css || css;
			sample = { ...Object.fromEntries(d.fields.map((f) => [f, ''])), ...d.sample };
			aiNotes = d.notes;
			tplIndex = 0;
			side = 'front';
			dirty = true;
			toast('Here’s a draft. Check the preview, then save.');
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			aiBusy = false;
		}
	}

	async function save() {
		saving = true;
		error = '';
		const renames = Object.fromEntries(fields.filter((f) => f.original && f.original !== f.name.trim()).map((f) => [f.original!, f.name.trim()]));
		const type = { ...$state.snapshot(def), renames };
		try {
			if (data.isNew) {
				const r = await api<{ id: string }>('/api/note-types', { body: { action: 'create', type } });
				toast('Card type saved');
				dirty = false;
				await goto(`/cards/types/${r.id}`, { replaceState: true });
			} else {
				await api('/api/note-types', { body: { action: 'update', id: data.type!.id, type } });
				toast('Card type saved');
				fields = fields.map((f) => ({ original: f.name.trim(), name: f.name.trim() }));
				dirty = false;
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	async function duplicate() {
		try {
			const r = await api<{ id: string }>('/api/note-types', { body: { action: 'duplicate', id: data.type!.id } });
			await goto(`/cards/types/${r.id}`);
		} catch (err) {
			toastError(err);
		}
	}

	const current = $derived(templates[Math.min(tplIndex, templates.length - 1)]);
</script>

<svelte:head><title>{data.isNew ? 'New card type' : (data.type?.name ?? 'Card type')} · Medicus Vitae</title></svelte:head>

<div class="page editor-page">
	<a href="/cards/types" class="back small"><Icon name="chevron-left" size={14} />Card types</a>
	<header class="page-header">
		<div style="flex: 1 1 20rem; min-width: 0">
			<label class="sr-only" for="nt-name">Name</label>
			<input id="nt-name" class="input title-input" bind:value={name} oninput={mark} placeholder="Card type name" disabled={!editable} />
			{#if data.type}<div class="subtitle">{data.type.notes} note{data.type.notes === 1 ? '' : 's'} use this type</div>{/if}
		</div>
		<div class="row-tight">
			{#if !editable}
				<button type="button" class="btn btn-primary" onclick={duplicate}><Icon name="copy" size={15} />Duplicate to edit</button>
			{:else}
				<button type="button" class="btn btn-primary" disabled={saving || (!dirty && !data.isNew)} onclick={save}>{saving ? 'Saving…' : 'Save'}</button>
			{/if}
		</div>
	</header>

	{#if !editable}
		<div class="notice small"><Icon name="info" size={15} />{data.type?.source === 'anki' ? 'From Anki: read-only here, because the next import or sync would put Anki’s version back.' : 'A built-in type: read-only.'} Duplicate it to change a copy.</div>
	{/if}
	{#if error}<div class="error-box" role="alert"><Icon name="alert" size={16} />{error}</div>{/if}

	{#if editable && data.ai}
		<section class="card ai-box">
			<label for="ai-ask" class="label"><Icon name="sparkle" size={14} /> Describe it and let the AI write the templates and script</label>
			<div class="row-tight" style="align-items: flex-start">
				<textarea
					id="ai-ask"
					class="textarea"
					rows="2"
					bind:value={aiAsk}
					placeholder={data.type || dirty ? 'e.g. add a button that shows a hint field, and make the answer side highlight the cloze in green' : 'e.g. a mechanism card: show the reagents, reveal each step with a button, then the product'}
				></textarea>
				<button type="button" class="btn btn-navy" disabled={aiBusy || !aiAsk.trim()} onclick={askAi}>{aiBusy ? 'Writing…' : data.type || dirty ? 'Change it' : 'Write it'}</button>
			</div>
			{#if aiNotes}<p class="small muted">{aiNotes}</p>{/if}
		</section>
	{/if}

	<div class="cols">
		<div class="stack">
			<section class="card stack-sm">
				<div class="row" style="justify-content: space-between">
					<h2 class="section-label">Fields</h2>
					<div class="segmented" role="radiogroup" aria-label="Kind">
						<button type="button" role="radio" aria-checked={kind === 'standard'} disabled={!editable || (!!data.type?.notes && data.type.kind === 'cloze')} onclick={() => ((kind = 'standard'), mark())}>Standard</button>
						<button type="button" role="radio" aria-checked={kind === 'cloze'} disabled={!editable || (!!data.type?.notes && data.type.kind === 'standard')} onclick={() => ((kind = 'cloze'), mark())}>Cloze</button>
					</div>
				</div>
				{#each fields as f, i (i)}
					<div class="row-tight field-row">
						<input class="input input-sm" bind:value={f.name} oninput={mark} aria-label="Field {i + 1} name" disabled={!editable} />
						<button type="button" class="icon-btn plain sm" aria-label="Insert {f.name} into the template" title="Insert into the template" disabled={!editable} onclick={() => insertField(f.name)}><Icon name="plus" size={14} /></button>
						<button type="button" class="icon-btn plain sm" aria-label="Move up" disabled={!editable || i === 0} onclick={() => moveField(i, -1)}><Icon name="arrow-up" size={14} /></button>
						<button type="button" class="icon-btn plain sm" aria-label="Move down" disabled={!editable || i === fields.length - 1} onclick={() => moveField(i, 1)}><Icon name="arrow-down" size={14} /></button>
						<button type="button" class="icon-btn plain sm" aria-label="Remove {f.name}" disabled={!editable || fields.length < 2} onclick={() => removeField(i)}><Icon name="x" size={14} /></button>
					</div>
				{/each}
				{#if editable}<button type="button" class="btn btn-sm btn-ghost" style="align-self: flex-start" onclick={addField}><Icon name="plus" size={14} />Add field</button>{/if}
			</section>

			<section class="card card-flush">
				<div class="tpl-head">
					{#if kind === 'standard'}
						<div class="tabs" role="tablist" aria-label="Card templates">
							{#each templates as t, i (i)}
								<button type="button" role="tab" aria-selected={tplIndex === i} onclick={() => (tplIndex = i)}>{t.name || `Card ${i + 1}`}</button>
							{/each}
							{#if editable}<button type="button" onclick={addTemplate} aria-label="Add a card template"><Icon name="plus" size={14} /></button>{/if}
						</div>
					{/if}
					<div class="row-tight" style="padding: 0.5rem 0.75rem 0">
						<div class="segmented" role="tablist" aria-label="Part">
							<button type="button" role="tab" aria-selected={side === 'front'} onclick={() => (side = 'front')}>Front template</button>
							<button type="button" role="tab" aria-selected={side === 'back'} onclick={() => (side = 'back')}>Back template</button>
							<button type="button" role="tab" aria-selected={side === 'css'} onclick={() => (side = 'css')}>Styling</button>
						</div>
						{#if kind === 'standard' && editable && side !== 'css'}
							<input class="input input-sm" style="width: 9rem" bind:value={templates[tplIndex].name} oninput={mark} aria-label="Card template name" />
							{#if templates.length > 1}<button type="button" class="btn btn-sm btn-ghost" onclick={() => removeTemplate(tplIndex)}>Remove card</button>{/if}
						{/if}
					</div>
				</div>
				<div style="padding: 0.5rem 0.75rem 0.75rem">
					{#if side === 'css'}
						<textarea class="textarea code" rows="16" bind:value={css} oninput={mark} spellcheck="false" disabled={!editable} aria-label="Styling (CSS)"></textarea>
					{:else if current}
						<textarea id="tpl-editor" class="textarea code" rows="16" bind:value={templates[tplIndex][side]} oninput={mark} spellcheck="false" disabled={!editable} aria-label="{side === 'front' ? 'Front' : 'Back'} template"></textarea>
					{/if}
					<p class="hint" style="margin-top: 0.375rem">
						Anki’s syntax: <span class="mono">{'{{Field}}'}</span>, <span class="mono">{'{{#Field}}…{{/Field}}'}</span>, <span class="mono">{'{{FrontSide}}'}</span>{kind === 'cloze' ? ', ' : ''}{#if kind === 'cloze'}<span class="mono">{'{{cloze:Text}}'}</span>{/if}. Scripts go in <span class="mono">&lt;script&gt;</span> tags and run in the card’s sealed frame (no access to the app or the internet).
					</p>
				</div>
			</section>
		</div>

		<div class="stack preview-col">
			<section class="card stack-sm">
				<div class="row" style="justify-content: space-between">
					<h2 class="section-label">Preview</h2>
					{#if kind === 'standard' && templates.length > 1}<span class="tiny muted">{current?.name}</span>{/if}
				</div>
				{#if preview}
					<div class="side-label tiny muted">Front</div>
					<div class="frame">{#key preview.front + css}<AnkiCard html={preview.front} {css} math={preview.math} ord={kind === 'cloze' ? 0 : tplIndex} mediaBase={preview.mediaBase} label="Front preview" />{/key}</div>
					<div class="side-label tiny muted">Back</div>
					<div class="frame">{#key preview.back + css}<AnkiCard html={preview.back} {css} math={preview.math} ord={kind === 'cloze' ? 0 : tplIndex} mediaBase={preview.mediaBase} label="Back preview" />{/key}</div>
					{#if preview.empty}<p class="hint">With these sample values this card would be empty (Anki wouldn’t make it).</p>{/if}
				{:else}
					<p class="small muted">The preview appears here.</p>
				{/if}
			</section>
			<section class="card stack-sm">
				<h2 class="section-label">Sample values</h2>
				{#each def.fields as f (f)}
					<label class="field"><span class="label">{f}</span><textarea class="textarea" rows="2" bind:value={sample[f]}></textarea></label>
				{/each}
			</section>
		</div>
	</div>
</div>

<style>
	.editor-page {
		max-width: 80rem;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--text-3);
		text-decoration: none;
		align-self: flex-start;
		margin-bottom: -0.5rem;
	}
	.title-input {
		font-size: 1.25rem;
		font-weight: 650;
		border-color: transparent;
		background: transparent;
		padding-left: 0.25rem;
	}
	.title-input:hover:not(:disabled) {
		border-color: var(--border);
	}
	.ai-box {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		border-color: var(--accent-border);
	}
	.ai-box .textarea {
		flex: 1 1 20rem;
		min-height: 3.5rem;
	}
	.cols {
		display: grid;
		grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 1000px) {
		.cols {
			grid-template-columns: 1fr;
		}
	}
	.field-row .input {
		flex: 1 1 auto;
	}
	.tpl-head .tabs {
		padding: 0 0.5rem;
	}
	.code {
		font-family: var(--font-mono);
		font-size: 0.8125rem;
		line-height: 1.55;
		tab-size: 2;
		white-space: pre;
		overflow-wrap: normal;
		overflow-x: auto;
	}
	.frame {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.5rem;
		min-height: 4rem;
	}
	.side-label {
		text-transform: uppercase;
		letter-spacing: 0.06em;
		font-weight: 600;
	}
	.preview-col {
		position: sticky;
		top: 1rem;
	}
</style>
