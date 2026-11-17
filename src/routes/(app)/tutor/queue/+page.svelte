<script lang="ts">
	import { invalidate } from '$app/navigation';
	import Icon from '#lib/components/Icon.svelte';
	import TutorTabs from '#lib/components/TutorTabs.svelte';
	import { api } from '#lib/client/api.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import { renderMarkdown } from '#lib/markdown.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Item = (typeof data.items)[number];
	const ready = $derived(data.items.filter((i) => !i.flagged));
	const flagged = $derived(data.items.filter((i) => i.flagged));

	let editing = $state<string | null>(null);
	let draft = $state<Record<string, string>>({});
	let busy = $state(false);

	const KIND_LABEL = { card: 'Card', question: 'Quiz question', note: 'Note' } as const;

	function startEdit(i: Item) {
		editing = i.id;
		const c = i.content as Record<string, unknown>;
		if (i.kind === 'card') draft = c.type === 'cloze' ? { text: String(c.text ?? ''), extra: String(c.extra ?? '') } : { front: String(c.front ?? ''), back: String(c.back ?? '') };
		else if (i.kind === 'question') {
			const ch = (c.choices as string[]) ?? [];
			draft = { stem: String(c.stem ?? ''), a: ch[0] ?? '', b: ch[1] ?? '', c: ch[2] ?? '', d: ch[3] ?? '', answer: String(c.answer ?? 0), explanation: String(c.explanation ?? '') };
		} else draft = { title: String(c.title ?? ''), body: String(c.body ?? '') };
	}

	function editsFor(i: Item) {
		if (editing !== i.id) return undefined;
		if (i.kind === 'question') return { stem: draft.stem, choices: [draft.a, draft.b, draft.c, draft.d], answer: Number(draft.answer), explanation: draft.explanation };
		return { ...draft };
	}

	async function act(i: Item, action: 'approve' | 'discard') {
		busy = true;
		try {
			await api('/api/ai/queue', { body: { action, id: i.id, edits: action === 'approve' ? editsFor(i) : undefined } });
			toast(action === 'approve' ? `${KIND_LABEL[i.kind]} added` : 'Discarded');
			editing = null;
			await invalidate('app:queue');
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	async function approveAll() {
		busy = true;
		try {
			const r = await api<{ approved: number }>('/api/ai/queue', { body: { action: 'approve_all', ids: ready.map((i) => i.id) } });
			toast(`${r.approved} item${r.approved === 1 ? '' : 's'} added`);
			await invalidate('app:queue');
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	const c = (i: Item) => i.content as Record<string, unknown>;
</script>

<svelte:head><title>Approvals · Tutor · Medicus Vitae</title></svelte:head>

{#snippet itemCard(i: Item)}
	<article class="card stack item" class:is-flagged={i.flagged}>
		<div class="row" style="justify-content: space-between">
			<div class="row-tight">
				<span class="pill pill-navy pill-sm"><Icon name="sparkle" size={12} stroke={2} />AI · {KIND_LABEL[i.kind]}</span>
				{#if i.aamcCode}<span class="code-tag">{i.aamcCode}</span>{/if}
				{#if i.book}<span class="tiny muted">{i.book}</span>{/if}
			</div>
		</div>
		{#if i.flagged && i.checks?.notes?.length}
			<div class="warning small"><Icon name="alert" size={16} /><div>{i.checks.notes.join(' ')}</div></div>
		{/if}

		{#if editing === i.id}
			{#if i.kind === 'card' && 'text' in draft}
				<div class="field"><label for="e-text-{i.id}">Cloze text</label><textarea id="e-text-{i.id}" class="textarea" rows="3" bind:value={draft.text}></textarea></div>
				<div class="field"><label for="e-extra-{i.id}">Back extra</label><textarea id="e-extra-{i.id}" class="textarea" rows="2" bind:value={draft.extra}></textarea></div>
			{:else if i.kind === 'card'}
				<div class="field"><label for="e-front-{i.id}">Front</label><textarea id="e-front-{i.id}" class="textarea" rows="2" bind:value={draft.front}></textarea></div>
				<div class="field"><label for="e-back-{i.id}">Back</label><textarea id="e-back-{i.id}" class="textarea" rows="3" bind:value={draft.back}></textarea></div>
			{:else if i.kind === 'question'}
				<div class="field"><label for="e-stem-{i.id}">Question</label><textarea id="e-stem-{i.id}" class="textarea" rows="3" bind:value={draft.stem}></textarea></div>
				{#each ['a', 'b', 'c', 'd'] as k, n (k)}
					<div class="row-tight">
						<label class="checkbox"><input type="radio" name="ans-{i.id}" value={String(n)} bind:group={draft.answer} />Correct</label>
						<input class="input" style="flex: 1" aria-label="Choice {k.toUpperCase()}" bind:value={draft[k]} />
					</div>
				{/each}
				<div class="field"><label for="e-expl-{i.id}">Explanation</label><textarea id="e-expl-{i.id}" class="textarea" rows="3" bind:value={draft.explanation}></textarea></div>
			{:else}
				<div class="field"><label for="e-title-{i.id}">Title</label><input id="e-title-{i.id}" class="input" bind:value={draft.title} /></div>
				<div class="field"><label for="e-body-{i.id}">Note</label><textarea id="e-body-{i.id}" class="textarea" rows="6" bind:value={draft.body}></textarea></div>
			{/if}
		{:else if i.kind === 'card'}
			{#if c(i).type === 'cloze'}
				<div class="md">{@html renderMarkdown(String(c(i).text ?? '').replace(/\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g, '**[$1]**'))}</div>
				{#if c(i).extra}<div class="md small muted">{@html renderMarkdown(String(c(i).extra))}</div>{/if}
			{:else}
				<div class="md strong">{@html renderMarkdown(String(c(i).front ?? ''))}</div>
				<div class="md">{@html renderMarkdown(String(c(i).back ?? ''))}</div>
			{/if}
		{:else if i.kind === 'question'}
			<div class="md strong">{@html renderMarkdown(String(c(i).stem ?? ''))}</div>
			<ol class="choices">
				{#each (c(i).choices as string[]) ?? [] as ch, n (n)}
					<li class:correct={Number(c(i).answer) === n}><span class="mono">{'ABCD'[n]}</span> {ch}{#if Number(c(i).answer) === n}<span class="sr-only"> (keyed answer)</span>{/if}</li>
				{/each}
			</ol>
			<div class="md small muted">{@html renderMarkdown(String(c(i).explanation ?? ''))}</div>
		{:else}
			<div class="strong">{String(c(i).title ?? '')}</div>
			<div class="md small">{@html renderMarkdown(String(c(i).body ?? ''))}</div>
		{/if}

		{#if i.sources.length}
			<div class="row-tight">
				{#each i.sources as s (s.n)}
					{#if s.anchorId && s.documentId}
						<a class="source-chip" class:missing={s.support === 'unsupported'} href="/library/{s.documentId}/read?anchor={s.anchorId}" title={s.exact.slice(0, 300)}><Icon name="book" size={13} stroke={2} />{s.label}</a>
					{:else}
						<span class="source-chip" title={s.exact.slice(0, 300)}><Icon name="book" size={13} stroke={2} />{s.label}</span>
					{/if}
				{/each}
			</div>
		{/if}

		<div class="row-tight">
			<button type="button" class="btn btn-primary btn-sm" disabled={busy} onclick={() => act(i, 'approve')}><Icon name="check" size={16} />{editing === i.id ? 'Save and approve' : 'Approve'}</button>
			{#if editing === i.id}
				<button type="button" class="btn btn-sm" onclick={() => (editing = null)}>Cancel edit</button>
			{:else}
				<button type="button" class="btn btn-sm" onclick={() => startEdit(i)}><Icon name="edit" size={16} />Edit</button>
			{/if}
			<button type="button" class="btn btn-sm btn-ghost" disabled={busy} onclick={() => act(i, 'discard')}>Discard</button>
		</div>
	</article>
{/snippet}

<div class="page narrow">
	<header class="page-header">
		<div>
			<h1>Approvals</h1>
			<p class="subtitle">AI-made cards, questions and notes enter your study only after you approve them. They’re marked as AI-made and never used as evidence by the tutor.</p>
		</div>
	</header>
	<TutorTabs current="queue" pending={data.items.length} quizCount={data.quizCount} />

	{#if !data.items.length}
		<div class="card empty">
			<Icon name="check" size={32} />
			<h2>Nothing waiting</h2>
			<p>Generate cards, questions or notes from a chapter on its book page (Library › a book › Generate).</p>
		</div>
	{:else}
		{#if ready.length}
			<div class="row" style="justify-content: space-between">
				<h2 style="font-size: 1.125rem">Passed their checks · {ready.length}</h2>
				<button type="button" class="btn btn-sm" disabled={busy} onclick={approveAll}>Approve all {ready.length}</button>
			</div>
			{#each ready as i (i.id)}{@render itemCard(i)}{/each}
		{/if}
		{#if flagged.length}
			<details class="flagged-group" open={!ready.length}>
				<summary class="row-tight"><Icon name="alert" size={16} /><strong>Needs a closer look · {flagged.length}</strong><span class="small muted">These didn’t pass a check. Review each one; they can’t be approved in bulk.</span></summary>
				<div class="stack" style="margin-top: 0.75rem">
					{#each flagged as i (i.id)}{@render itemCard(i)}{/each}
				</div>
			</details>
		{/if}
	{/if}
</div>

<style>
	.narrow {
		max-width: 52rem;
	}
	.item.is-flagged {
		border-color: var(--weak-border);
	}
	.choices {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.choices li {
		padding: 0.375rem 0.625rem;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
	}
	.choices li.correct {
		background: var(--accent-soft);
		color: var(--accent-text);
		font-weight: 600;
	}
	.flagged-group summary {
		cursor: pointer;
		flex-wrap: wrap;
	}
</style>
