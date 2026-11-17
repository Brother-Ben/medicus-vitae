<script lang="ts" module>
	export interface MistakeDraft {
		sourceType: 'practice' | 'full_length' | 'card' | 'external';
		sourceRef: string;
		fullLengthId: string | null;
		practiceSetId: string | null;
		cardId: string | null;
		aamcCode: string | null;
		skillCode: string | null;
		reason: string;
		summary: string;
		whatToDo: string;
		links?: { kind: 'card' | 'anchor'; refId: string }[];
	}

	export function emptyMistake(partial: Partial<MistakeDraft> = {}): MistakeDraft {
		return {
			sourceType: 'external',
			sourceRef: '',
			fullLengthId: null,
			practiceSetId: null,
			cardId: null,
			aamcCode: null,
			skillCode: null,
			reason: '',
			summary: '',
			whatToDo: '',
			...partial
		};
	}
</script>

<script lang="ts">
	import { api } from '#lib/client/api.js';
	import { toast } from '#lib/client/toast.svelte.js';
	import { MISTAKE_REASONS, SKILLS } from '#lib/aamc.js';
	import CategorySelect from './CategorySelect.svelte';
	import Icon from './Icon.svelte';
	import Modal from './Modal.svelte';

	let {
		open = $bindable(false),
		draft,
		mistakeId = null,
		fullLengths = [],
		practiceSets = [],
		lockSource = false,
		onsaved
	}: {
		open?: boolean;
		draft: MistakeDraft;
		mistakeId?: string | null;
		fullLengths?: { id: string; label: string }[];
		practiceSets?: { id: string; label: string }[];
		lockSource?: boolean;
		onsaved?: (id: string) => void;
	} = $props();

	let m = $state<MistakeDraft>(emptyMistake());
	let saving = $state(false);
	let error = $state('');

	$effect(() => {
		if (open) {
			m = { ...draft };
			error = '';
		}
	});

	const sources = [
		{ v: 'practice', l: 'Practice questions' },
		{ v: 'full_length', l: 'Full-length exam' },
		{ v: 'card', l: 'Flashcard' },
		{ v: 'external', l: 'Somewhere else' }
	];

	async function save(e: Event) {
		e.preventDefault();
		if (!m.reason) {
			error = 'Pick why you missed it.';
			return;
		}
		saving = true;
		error = '';
		try {
			if (mistakeId) {
				await api(`/api/mistakes/${mistakeId}`, { method: 'PATCH', body: m });
				toast('Mistake updated');
				onsaved?.(mistakeId);
			} else {
				const r = await api<{ id: string }>('/api/mistakes', { body: m });
				toast('Logged to your mistake journal');
				onsaved?.(r.id);
			}
			open = false;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:open title={mistakeId ? 'Edit mistake' : 'Log a mistake'} wide>
	<form id="mistake-form" class="stack" onsubmit={save}>
		<div class="form-grid">
			<div class="field">
				<label for="m-source">Where it came from</label>
				<select id="m-source" class="select" bind:value={m.sourceType} disabled={lockSource}>
					{#each sources as s (s.v)}<option value={s.v}>{s.l}</option>{/each}
				</select>
			</div>
			{#if m.sourceType === 'full_length'}
				<div class="field">
					<label for="m-fl">Which full-length</label>
					<select id="m-fl" class="select" bind:value={m.fullLengthId}>
						<option value={null}>Choose…</option>
						{#each fullLengths as f (f.id)}<option value={f.id}>{f.label}</option>{/each}
					</select>
				</div>
			{:else if m.sourceType === 'practice' && practiceSets.length}
				<div class="field">
					<label for="m-ps">Practice set <span class="muted">(optional)</span></label>
					<select id="m-ps" class="select" bind:value={m.practiceSetId}>
						<option value={null}>None</option>
						{#each practiceSets as p (p.id)}<option value={p.id}>{p.label}</option>{/each}
					</select>
				</div>
			{/if}
			<div class="field">
				<label for="m-ref">Question reference <span class="muted">(optional)</span></label>
				<input id="m-ref" class="input" bind:value={m.sourceRef} placeholder="e.g. C/P passage 3, Q12" />
			</div>
		</div>

		<fieldset class="field" style="border: 0; padding: 0; margin: 0">
			<legend class="label" style="margin-bottom: 0.375rem">Why you missed it</legend>
			<div class="row-tight">
				{#each MISTAKE_REASONS as r (r.code)}
					<label class="reason">
						<input type="radio" name="reason" value={r.code} bind:group={m.reason} />
						<span>{r.label}</span>
					</label>
				{/each}
			</div>
		</fieldset>

		<div class="form-grid">
			<div class="field">
				<label for="m-cat">AAMC category</label>
				<CategorySelect id="m-cat" bind:value={m.aamcCode} />
			</div>
			<div class="field">
				<label for="m-skill">Reasoning skill</label>
				<select id="m-skill" class="select" bind:value={m.skillCode}>
					<option value={null}>Not sure</option>
					<optgroup label="Science sections">
						{#each SKILLS.filter((s) => s.kind === 'SIRS') as s (s.code)}<option value={s.code}>{s.code}: {s.name}</option>{/each}
					</optgroup>
					<optgroup label="CARS">
						{#each SKILLS.filter((s) => s.kind === 'CARS') as s (s.code)}<option value={s.code}>{s.code}: {s.name}</option>{/each}
					</optgroup>
				</select>
			</div>
		</div>

		<div class="field">
			<label for="m-summary">What the question tested</label>
			<textarea id="m-summary" class="textarea" rows="2" bind:value={m.summary} placeholder="e.g. Effect of a noncompetitive inhibitor on Km"></textarea>
		</div>
		<div class="field">
			<label for="m-todo">What to do differently</label>
			<textarea id="m-todo" class="textarea" rows="2" bind:value={m.whatToDo} placeholder="e.g. Sketch the Lineweaver–Burk plot before answering"></textarea>
		</div>
		{#if error}<div class="error-box" role="alert"><Icon name="alert" size={18} />{error}</div>{/if}
	</form>
	{#snippet footer()}
		<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
		<button type="submit" form="mistake-form" class="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : mistakeId ? 'Save' : 'Log mistake'}</button>
	{/snippet}
</Modal>

<style>
	.reason {
		position: relative;
		cursor: pointer;
	}
	.reason input {
		position: absolute;
		opacity: 0;
		inset: 0;
		cursor: pointer;
	}
	.reason span {
		display: inline-flex;
		align-items: center;
		min-height: 40px;
		padding: 0 0.875rem;
		border: 1px solid var(--border-strong);
		border-radius: 999px;
		font-size: 0.875rem;
		font-weight: 600;
	}
	.reason input:checked + span {
		background: var(--ink);
		border-color: var(--ink);
		color: var(--on-ink);
	}
	.reason input:focus-visible + span {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
</style>
