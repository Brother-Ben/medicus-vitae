<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import CardsTabs from '#lib/components/CardsTabs.svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import OcclusionEditor from '#lib/components/OcclusionEditor.svelte';
	import { api } from '#lib/client/api.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const SOURCE: Record<string, string> = { builtin: 'Built in', custom: 'Made here', anki: 'From Anki' };
	let ioOpen = $state(false);
	let deleting = $state<(typeof data.types)[number] | null>(null);
	let deleteOpen = $state(false);

	async function duplicate(id: string) {
		try {
			const r = await api<{ id: string }>('/api/note-types', { body: { action: 'duplicate', id } });
			toast('Copy made: edit it as you like');
			await goto(`/cards/types/${r.id}`);
		} catch (err) {
			toastError(err);
		}
	}

	async function remove() {
		if (!deleting) return;
		await api('/api/note-types', { body: { action: 'delete', id: deleting.id } });
		toast('Card type deleted');
		await invalidate('app:note-types');
	}
</script>

<svelte:head><title>Card types · Flashcards · Medicus Vitae</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div>
			<h1>Flashcards</h1>
			<div class="subtitle">Card types: the fields, templates, styling and scripts cards are made from, as in Anki</div>
		</div>
		<div class="row-tight">
			<button type="button" class="btn" onclick={() => (ioOpen = true)}><Icon name="image" size={16} />Image occlusion card</button>
			<a class="btn btn-primary" href="/cards/types/new"><Icon name="plus" size={16} />New card type</a>
		</div>
	</header>

	<CardsTabs carsWaiting={data.carsWaiting} />

	{#if data.ai}
		<a class="card ai-tile" href="/cards/types/new?ai=1">
			<Icon name="sparkle" size={18} />
			<span>
				<span class="strong">Describe a card type and let the AI write it</span>
				<span class="small muted">e.g. “a card that reveals the steps of a mechanism one at a time”, or “hide the labels on a diagram until I tap them”. You review the templates and script before saving.</span>
			</span>
		</a>
	{/if}

	<section class="card card-flush">
		<div class="list">
			{#each data.types as t (t.id)}
				<div class="list-row">
					<a class="t-main" href="/cards/types/{t.id}">
						<span class="list-title">{t.name}</span>
						<span class="list-sub">
							{SOURCE[t.source] ?? t.source} · {t.kind === 'cloze' ? 'Cloze' : `${t.templates.length} card${t.templates.length === 1 ? '' : 's'} per note`} · {t.fields.length} field{t.fields.length === 1 ? '' : 's'} · {t.notes} note{t.notes === 1 ? '' : 's'}
						</span>
					</a>
					{#if t.scripts}<span class="pill pill-sm" title="Its templates run JavaScript (in the sealed card frame)"><Icon name="code" size={11} />Script</span>{/if}
					<div class="row-tight">
						<a class="btn btn-sm btn-ghost" href="/cards/types/{t.id}">{t.editable ? 'Edit' : 'View'}</a>
						<button type="button" class="btn btn-sm btn-ghost" onclick={() => duplicate(t.id)}>Duplicate</button>
						{#if t.editable}
							<button
								type="button"
								class="icon-btn plain sm"
								aria-label="Delete {t.name}"
								title={t.notes ? 'Cards use this type' : 'Delete'}
								disabled={t.notes > 0}
								onclick={() => {
									deleting = t;
									deleteOpen = true;
								}}><Icon name="trash" size={15} /></button
							>
						{/if}
					</div>
				</div>
			{/each}
		</div>
	</section>
	<p class="small muted">Types from Anki are read-only here (the next import or sync would put Anki’s version back): duplicate one to change a copy. Cards made with your own types can be studied here; send-to-Anki covers Basic, Cloze and Image occlusion.</p>
</div>

<OcclusionEditor bind:open={ioOpen} onsaved={() => invalidate('app:note-types')} />

<ConfirmDialog bind:open={deleteOpen} title="Delete this card type?" confirmLabel="Delete" onconfirm={remove}>
	<p>{deleting?.name} isn’t used by any cards, so nothing else changes.</p>
</ConfirmDialog>

<style>
	.ai-tile {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		text-decoration: none;
		color: var(--text);
		border-color: var(--accent-border);
	}
	.ai-tile > span {
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.ai-tile :global(svg) {
		color: var(--accent-text);
		margin-top: 0.125rem;
	}
	.t-main {
		flex: 1 1 16rem;
		min-width: 0;
		display: flex;
		flex-direction: column;
		color: inherit;
		text-decoration: none;
	}
	.t-main:hover .list-title {
		text-decoration: underline;
	}
</style>
