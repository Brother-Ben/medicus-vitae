<script lang="ts">
	import { api } from '#lib/client/api.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import { addDays, shortDate } from '#lib/dates.js';
	import Modal from './Modal.svelte';

	// "Set due date" for one card, a selection, or a whole deck.

	let {
		open = $bindable(false),
		today,
		cardIds = [],
		deck = null,
		label = '',
		onsaved
	}: {
		open?: boolean;
		/** Today's study day (YYYY-MM-DD). */
		today: string;
		cardIds?: string[];
		/** Set for a whole deck (and its subdecks) instead of cardIds. */
		deck?: string | null;
		/** What is being changed, e.g. "this card" or "12 cards". */
		label?: string;
		onsaved?: () => void;
	} = $props();

	type Mode = 'quick' | 'days' | 'date' | 'range';
	let mode = $state<Mode>('quick');
	let quick = $state(1);
	let days = $state(3);
	let date = $state('');
	let min = $state(1);
	let max = $state(7);
	let scope = $state<'due' | 'review' | 'all'>('due');
	let saving = $state(false);

	$effect(() => {
		if (open) {
			if (!date) date = addDays(today, 7);
		}
	});

	const QUICK = [
		{ d: 0, l: 'Today' },
		{ d: 1, l: 'Tomorrow' },
		{ d: 3, l: 'In 3 days' },
		{ d: 7, l: 'In a week' },
		{ d: 14, l: 'In 2 weeks' },
		{ d: 30, l: 'In a month' }
	];

	const summary = $derived.by(() => {
		if (mode === 'quick') return quick === 0 ? 'They come up today.' : `They come up on ${shortDate(addDays(today, quick))}.`;
		if (mode === 'days') return Number(days) >= 0 ? `They come up on ${shortDate(addDays(today, Math.round(Number(days) || 0)))}.` : '';
		if (mode === 'date') return date && date >= today ? `They come up on ${shortDate(date)}.` : 'Pick today or a later day.';
		const lo = Math.min(Number(min), Number(max));
		const hi = Math.max(Number(min), Number(max));
		return `Each card gets a random day between ${shortDate(addDays(today, lo))} and ${shortDate(addDays(today, hi))}, so they don’t all land on one day.`;
	});

	async function save() {
		const spec =
			mode === 'quick'
				? { kind: 'days', days: quick }
				: mode === 'days'
					? { kind: 'days', days: Number(days) }
					: mode === 'date'
						? { kind: 'date', date }
						: { kind: 'range', min: Number(min), max: Number(max) };
		saving = true;
		try {
			const r = await api<{ changed: number; skipped: number }>('/api/cards/due', {
				body: deck ? { deck, scope, spec, includeNew: scope === 'all' } : { cardIds, spec }
			});
			toast(r.changed ? `Due date set for ${r.changed} card${r.changed === 1 ? '' : 's'}` : 'No cards needed changing');
			open = false;
			onsaved?.();
		} catch (err) {
			toastError(err);
		} finally {
			saving = false;
		}
	}
</script>

<Modal bind:open title="Set due date">
	<p class="small muted" style="margin-top: -0.25rem">
		{deck ? `Cards in ${deck.split('::').join(' › ')}` : label || `${cardIds.length} card${cardIds.length === 1 ? '' : 's'}`}. Only the date moves: how well you know each card stays the same.
	</p>

	{#if deck}
		<div class="field">
			<span class="label" id="due-scope">Which cards</span>
			<div class="segmented" role="radiogroup" aria-labelledby="due-scope">
				{#each [['due', 'Due now'], ['review', 'All studied cards'], ['all', 'Every card, new too']] as [v, l] (v)}
					<button type="button" role="radio" aria-checked={scope === v} onclick={() => (scope = v as typeof scope)}>{l}</button>
				{/each}
			</div>
			{#if scope === 'all'}<span class="hint">New cards stay new; they just won’t show up before that day.</span>{/if}
		</div>
	{/if}

	<div class="field">
		<span class="label" id="due-mode">When</span>
		<div class="segmented" role="radiogroup" aria-labelledby="due-mode">
			{#each [['quick', 'Quick pick'], ['days', 'In N days'], ['date', 'On a date'], ['range', 'Spread out']] as [v, l] (v)}
				<button type="button" role="radio" aria-checked={mode === v} onclick={() => (mode = v as Mode)}>{l}</button>
			{/each}
		</div>
	</div>

	{#if mode === 'quick'}
		<div class="row-tight" role="radiogroup" aria-label="Quick pick">
			{#each QUICK as q (q.d)}
				<button type="button" class="btn btn-sm" class:chosen={quick === q.d} role="radio" aria-checked={quick === q.d} onclick={() => (quick = q.d)}>{q.l}</button>
			{/each}
		</div>
	{:else if mode === 'days'}
		<div class="row-tight">
			<label for="due-days" class="sr-only">Days from today</label>
			<input id="due-days" class="input mono" style="width: 7rem" type="number" min="0" max="3650" bind:value={days} />
			<span class="muted">days from today</span>
		</div>
	{:else if mode === 'date'}
		<div>
			<label for="due-date" class="sr-only">Date</label>
			<input id="due-date" class="input" style="width: 12rem" type="date" min={today} bind:value={date} />
		</div>
	{:else}
		<div class="row-tight">
			<span class="muted">Between</span>
			<label for="due-min" class="sr-only">First day</label>
			<input id="due-min" class="input mono" style="width: 5.5rem" type="number" min="0" max="3650" bind:value={min} />
			<span class="muted">and</span>
			<label for="due-max" class="sr-only">Last day</label>
			<input id="due-max" class="input mono" style="width: 5.5rem" type="number" min="0" max="3650" bind:value={max} />
			<span class="muted">days from today</span>
		</div>
	{/if}

	<p class="small">{summary}</p>

	{#snippet footer()}
		<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" disabled={saving || (mode === 'date' && (!date || date < today))} onclick={save}>{saving ? 'Saving…' : 'Set due date'}</button>
	{/snippet}
</Modal>

<style>
	.chosen {
		background: var(--ink);
		border-color: var(--ink);
		color: var(--on-ink);
	}
	.chosen:hover {
		background: var(--ink-hover);
		color: var(--on-ink);
	}
</style>
