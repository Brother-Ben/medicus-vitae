<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import MistakeForm, { type MistakeDraft } from '#lib/components/MistakeForm.svelte';
	import { trackActivity } from '#lib/client/activity.js';
	import { api } from '#lib/client/api.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import { CATEGORY_SHORT, MISTAKE_STATE_LABELS, reasonLabel, skill, type MistakeState } from '#lib/aamc.js';
	import { relativeTime, shortDate } from '#lib/dates.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const m = $derived(data.mistake);
	const STEPS: MistakeState[] = ['open', 'repair', 'retest', 'resolved'];
	const stepIndex = $derived(STEPS.indexOf(m.state as MistakeState));

	let explanation = $derived(data.mistake.repairExplanation);
	let revisited = $derived(data.mistake.passageRevisited);
	let retestDays = $state(2);
	let retestRef = $state('');
	let busy = $state(false);
	let editOpen = $state(false);
	let editDraft = $state<MistakeDraft | null>(null);

	onMount(() => trackActivity('mistakes'));

	async function act(body: Record<string, unknown>, message: string) {
		busy = true;
		try {
			await api(`/api/mistakes/${m.id}`, { body });
			toast(message);
			if (body.action === 'retest' && data.sessionId && data.itemId) {
				await api(`/api/session/${data.sessionId}`, { body: { itemId: data.itemId, done: true } }).catch(() => {});
			}
			if (body.action === 'complete-repair' && data.sessionId && data.itemId) {
				await api(`/api/session/${data.sessionId}`, { body: { itemId: data.itemId, done: true } }).catch(() => {});
			}
			await invalidate('app:mistake');
			await invalidate('app:shell');
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	async function remove() {
		if (!confirm('Delete this mistake from your journal?')) return;
		try {
			await api(`/api/mistakes/${m.id}`, { body: { action: 'delete' } });
			toast('Deleted');
			await goto('/mistakes');
		} catch (err) {
			toastError(err);
		}
	}

	function openEdit() {
		editDraft = {
			sourceType: m.sourceType as MistakeDraft['sourceType'],
			sourceRef: m.sourceRef,
			fullLengthId: m.fullLengthId,
			practiceSetId: m.practiceSetId,
			cardId: m.cardId,
			aamcCode: m.aamcCode,
			skillCode: m.skillCode,
			reason: m.reason,
			summary: m.summary,
			whatToDo: m.whatToDo
		};
		editOpen = true;
	}

	const findPassageHref = $derived(m.summary ? `/search?q=${encodeURIComponent(m.summary.split(/\s+/).slice(0, 6).join(' '))}` : '/search');
</script>

<svelte:head><title>Mistake · Medicus Vitae</title></svelte:head>

<div class="page page-narrow" style="max-width: 52rem">
	<a href={data.sessionId ? `/session/${data.sessionId}` : '/mistakes'} class="btn btn-ghost btn-sm" style="align-self: flex-start">
		<Icon name="chevron-left" size={16} />{data.sessionId ? 'Back to session' : 'Mistake journal'}
	</a>

	<header class="stack-sm">
		<div class="row-tight">
			{#if m.aamcCode}<span class="code-tag">{m.aamcCode}</span><span class="topic-tag">{CATEGORY_SHORT[m.aamcCode] ?? ''}</span>{/if}
			{#if m.skillCode}<span class="topic-tag">{skill(m.skillCode)?.name ?? m.skillCode}</span>{/if}
			<span class="topic-tag">{reasonLabel(m.reason)}</span>
		</div>
		<h1>{m.summary || 'Untitled mistake'}</h1>
		<div class="small muted">
			Logged {shortDate(m.studyDay)}
			{#if data.fullLength} · from <a href="/progress/full-lengths/{data.fullLength.id}">{data.fullLength.provider} {data.fullLength.form}</a>{/if}
			{#if data.practiceSet} · from {data.practiceSet.source} ({shortDate(data.practiceSet.date)}){/if}
			{#if m.sourceRef} · {m.sourceRef}{/if}
			{#if m.reopenedCount} · reopened {m.reopenedCount}×{/if}
		</div>
	</header>

	<ol class="stepper" aria-label="Repair progress">
		{#each STEPS as s, i (s)}
			<li class:done={i < stepIndex} class:current={i === stepIndex}>
				<span class="dot mono">{i < stepIndex ? '✓' : i + 1}</span>{MISTAKE_STATE_LABELS[s]}
			</li>
		{/each}
	</ol>

	{#if m.whatToDo}
		<div class="card card-tight">
			<div class="tiny muted strong" style="text-transform: uppercase; letter-spacing: 0.06em">What to do differently</div>
			<p style="margin-top: 0.375rem">{m.whatToDo}</p>
		</div>
	{/if}

	<section class="card stack">
		{#if m.state === 'open'}
			<h2>Repair it</h2>
			<p class="muted">Go back to the source: re-read the passage behind this question and explain the idea in your own words. Then a retest on a different question checks the fix.</p>
			<div><button type="button" class="btn btn-primary" disabled={busy} onclick={() => act({ action: 'start-repair' }, 'Repair started')}><Icon name="play" size={18} />Start repair</button></div>
		{:else if m.state === 'repair'}
			<h2>Repair</h2>
			<div class="stack-sm">
				<div class="label">1. Revisit the passage</div>
				{#if data.passages.length}
					{#each data.passages as p (p.linkId)}
						{#if p.anchor?.available}
							<a class="source-chip" href="/library/{p.anchor.documentId}/read?anchor={p.anchor.id}"><Icon name="book" size={13} stroke={2} />{p.label}</a>
						{:else}
							<span class="source-chip missing"><Icon name="alert" size={13} stroke={2} />Source missing · {p.label}</span>
						{/if}
					{/each}
				{:else}
					<p class="small muted">No passage linked. <a href={findPassageHref}>Search your books</a> for it.</p>
				{/if}
				<label class="checkbox"><input type="checkbox" bind:checked={revisited} />I re-read the passage</label>
			</div>
			<div class="field">
				<label for="explain" class="label">2. Explain the idea in your own words</label>
				<textarea id="explain" class="textarea reading" rows="5" bind:value={explanation} placeholder="Why is the right answer right, and why did the trap look right?"></textarea>
			</div>
			<div class="field" style="max-width: 16rem">
				<label for="retest-days">3. Retest after</label>
				<select id="retest-days" class="select" bind:value={retestDays}>
					{#each [1, 2, 3, 5, 7, 14] as d (d)}<option value={d}>{d} day{d === 1 ? '' : 's'}</option>{/each}
				</select>
			</div>
			<div>
				<button
					type="button"
					class="btn btn-primary"
					disabled={busy || explanation.trim().length < 10}
					onclick={() => act({ action: 'complete-repair', explanation, passageRevisited: revisited, retestInDays: retestDays }, 'Repaired. Retest scheduled.')}
				>Finish repair</button>
			</div>
		{:else if m.state === 'retest'}
			<h2>Retest</h2>
			{#if m.retestDue && m.retestDue > data.today}
				<div class="notice"><Icon name="clock" size={18} />Scheduled for {shortDate(m.retestDue)}. You can retest early, but a gap of a few days tests memory better.</div>
			{/if}
			<p class="muted">Answer a <strong>different</strong> question on the same idea, not the one you missed. Find one in a question bank, then record how it went.</p>
			{#if m.repairExplanation}
				<details>
					<summary class="small strong">Your explanation</summary>
					<p class="reading" style="margin-top: 0.5rem; white-space: pre-wrap">{m.repairExplanation}</p>
				</details>
			{/if}
			<div class="field" style="max-width: 24rem">
				<label for="retest-ref">Which question <span class="muted">(optional)</span></label>
				<input id="retest-ref" class="input" bind:value={retestRef} placeholder="e.g. UWorld #4512" />
			</div>
			<div class="row">
				<button type="button" class="btn btn-primary" disabled={busy} onclick={() => act({ action: 'retest', correct: true, externalRef: retestRef }, 'Resolved. Nice work.')}>
					<Icon name="check" size={18} />Got it right
				</button>
				<button type="button" class="btn" disabled={busy} onclick={() => act({ action: 'retest', correct: false, externalRef: retestRef }, 'Reopened. Repair it again.')}>
					<Icon name="x" size={18} />Missed it again
				</button>
			</div>
		{:else}
			<h2>Resolved</h2>
			<p class="muted">Resolved {m.resolvedAt ? relativeTime(m.resolvedAt) : ''} after a successful retest.</p>
			<div><button type="button" class="btn" disabled={busy} onclick={() => act({ action: 'reopen' }, 'Reopened')}>Reopen</button></div>
		{/if}
	</section>

	{#if data.cards.length}
		<section class="card stack-sm">
			<h2>Related cards</h2>
			{#each data.cards as c (c.cardId)}
				<div class="row" style="justify-content: space-between">
					<span class="small" class:muted={c.deleted}>{c.preview}{c.deleted ? ' (deleted)' : ''}</span>
					{#if c.sourceAnchorId}<span class="tiny muted">{c.sourceLabel}</span>{/if}
				</div>
			{/each}
		</section>
	{/if}

	<section class="card stack-sm">
		<h2>History</h2>
		<ol class="timeline">
			{#each data.events as e (e.id)}
				<li><span class="small strong">{e.note || MISTAKE_STATE_LABELS[e.toState as MistakeState]}</span> <span class="tiny muted">{relativeTime(e.createdAt)}</span></li>
			{/each}
			{#each data.attempts as a (a.id)}
				<li><span class="small">Retest {a.attemptNumber}: <strong>{a.correct ? 'correct' : 'missed'}</strong>{a.externalRef ? ` · ${a.externalRef}` : ''}</span> <span class="tiny muted">{relativeTime(a.attemptedAt)}</span></li>
			{/each}
		</ol>
	</section>

	<div class="row">
		<button type="button" class="btn" onclick={openEdit}><Icon name="edit" size={18} />Edit</button>
		<button type="button" class="btn btn-danger" onclick={remove}><Icon name="trash" size={18} />Delete</button>
	</div>
</div>

{#if editDraft}
	<MistakeForm bind:open={editOpen} draft={editDraft} mistakeId={m.id} fullLengths={data.fullLengths} practiceSets={data.practiceSets} onsaved={() => invalidate('app:mistake')} />
{/if}

<style>
	.stepper {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.5rem;
	}
	.stepper li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-3);
		padding: 0.625rem;
		border-radius: var(--radius);
		background: var(--surface);
		border: 1px solid var(--border);
	}
	.stepper li.current {
		color: var(--text);
		border-color: var(--accent);
	}
	.stepper .dot {
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 999px;
		background: var(--surface-2);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.75rem;
		flex: none;
	}
	.stepper li.current .dot {
		background: var(--accent);
		color: var(--on-accent);
	}
	.stepper li.done .dot {
		background: var(--accent-soft);
		color: var(--accent-text);
	}
	@media (max-width: 600px) {
		.stepper {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.timeline {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		border-left: 2px solid var(--border);
		padding-left: 0.875rem;
	}
</style>
