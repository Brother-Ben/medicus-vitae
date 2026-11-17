<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import CategorySelect from '#lib/components/CategorySelect.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import MistakeForm, { emptyMistake, type MistakeDraft } from '#lib/components/MistakeForm.svelte';
	import { CATEGORY_SHORT, MISTAKE_REASONS, MISTAKE_STATE_LABELS, reasonLabel, type MistakeState } from '#lib/aamc.js';
	import { shortDate } from '#lib/dates.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let formOpen = $state(false);
	let draft = $state<MistakeDraft>(emptyMistake());
	let aamcFilter = $derived<string | null>(data.aamc);

	onMount(() => {
		const params = new URLSearchParams(location.search);
		if (params.has('new')) {
			draft = emptyMistake({
				sourceType: (params.get('source') as MistakeDraft['sourceType']) ?? 'external',
				fullLengthId: params.get('fl'),
				aamcCode: params.get('aamc')
			});
			formOpen = true;
		}
	});

	function filterHref(patch: Record<string, string | null>) {
		const p = new URLSearchParams();
		const merged = { state: data.state, aamc: data.aamc, reason: data.reason, ...patch };
		for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
		return `/mistakes?${p.toString()}`;
	}

	const stateTone: Record<MistakeState, string> = {
		open: 'pill-warn',
		repair: 'pill-navy',
		retest: 'pill-accent',
		resolved: ''
	};
</script>

<svelte:head><title>Mistake journal · Medicus Vitae</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div>
			<h1>Mistake journal</h1>
			<p class="subtitle">Log what you missed and why, repair it, then retest on a new question.</p>
		</div>
		<button
			type="button"
			class="btn btn-primary"
			onclick={() => {
				draft = emptyMistake();
				formOpen = true;
			}}><Icon name="plus" size={18} />Log a mistake</button
		>
	</header>

	{#if data.counts.retestDue}
		<div class="notice"><Icon name="target" size={18} />{data.counts.retestDue} mistake{data.counts.retestDue === 1 ? ' is' : 's are'} ready for a retest.</div>
	{/if}

	<div class="row" style="justify-content: space-between">
		<div class="segmented" role="tablist" aria-label="Which mistakes">
			<a href={filterHref({ state: 'active' })} aria-current={data.state === 'active' ? 'page' : undefined}>Active · {data.counts.active}</a>
			<a href={filterHref({ state: 'resolved' })} aria-current={data.state === 'resolved' ? 'page' : undefined}>Resolved · {data.counts.resolved}</a>
			<a href={filterHref({ state: 'all' })} aria-current={data.state === 'all' ? 'page' : undefined}>All · {data.counts.all}</a>
		</div>
		<div class="row-tight">
			<label for="f-aamc" class="sr-only">Category</label>
			<div style="width: 14rem">
				<CategorySelect id="f-aamc" bind:value={aamcFilter} placeholder="All categories" />
			</div>
			<button type="button" class="btn btn-sm" onclick={() => goto(filterHref({ aamc: aamcFilter }))}>Filter</button>
			<label for="f-reason" class="sr-only">Reason</label>
			<select id="f-reason" class="select" style="width: 12rem" value={data.reason ?? ''} onchange={(e) => goto(filterHref({ reason: (e.currentTarget as HTMLSelectElement).value || null }))}>
				<option value="">All reasons</option>
				{#each MISTAKE_REASONS as r (r.code)}<option value={r.code}>{r.label}</option>{/each}
			</select>
		</div>
	</div>

	{#if data.mistakes.length}
		<div class="card" style="padding: 0.25rem 1.25rem">
			<div class="list">
				{#each data.mistakes as m (m.id)}
					<a class="list-row mistake-row" href="/mistakes/{m.id}">
						<span class="pill {stateTone[m.state as MistakeState]}" style="min-width: 7.5rem; justify-content: center">
							{MISTAKE_STATE_LABELS[m.state as MistakeState]}
						</span>
						<div style="flex: 1 1 18rem; min-width: 0">
							<div class="list-title truncate">{m.summary || 'Untitled mistake'}</div>
							<div class="list-sub">
								{reasonLabel(m.reason)}
								{#if m.fullLengthName} · {m.fullLengthName}{:else if m.sourceRef} · {m.sourceRef}{/if}
								· {shortDate(m.studyDay)}
								{#if m.state === 'retest' && m.retestDue} · retest {m.retestDue <= data.today ? 'due now' : `on ${shortDate(m.retestDue)}`}{/if}
								{#if m.reopenedCount} · reopened {m.reopenedCount}×{/if}
							</div>
						</div>
						{#if m.aamcCode}
							<span class="row-tight"><span class="code-tag">{m.aamcCode}</span><span class="small muted">{CATEGORY_SHORT[m.aamcCode] ?? ''}</span></span>
						{/if}
						<Icon name="chevron-right" size={18} />
					</a>
				{/each}
			</div>
		</div>
	{:else}
		<div class="card empty">
			<Icon name="journal" size={32} />
			<h2>{data.state === 'active' ? 'No open mistakes' : 'Nothing here'}</h2>
			<p>Log a question you missed: what it tested, why you missed it, and what you’ll do differently.</p>
		</div>
	{/if}
</div>

<MistakeForm bind:open={formOpen} {draft} fullLengths={data.fullLengths} practiceSets={data.practiceSets} onsaved={(id) => goto(`/mistakes/${id}`)} />

<style>
	.mistake-row {
		text-decoration: none;
		color: inherit;
		border-radius: 0;
	}
	.mistake-row:hover .list-title {
		color: var(--accent-text);
	}
</style>
