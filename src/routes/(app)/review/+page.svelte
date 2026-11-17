<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import AnkiCard from '#lib/components/AnkiCard.svelte';
	import CardEditor, { type CardDraft } from '#lib/components/CardEditor.svelte';
	import CodeTag from '#lib/components/CodeTag.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import MistakeForm, { emptyMistake, type MistakeDraft } from '#lib/components/MistakeForm.svelte';
	import RegionImage from '#lib/components/RegionImage.svelte';
	import { trackActivity } from '#lib/client/activity.js';
	import { appearance } from '#lib/client/appearance.svelte.js';
	import { api } from '#lib/client/api.js';
	import { deviceId, nextDeviceSeq } from '#lib/client/device.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import { CATEGORY_SHORT } from '#lib/aamc.js';
	import { CONFIDENCE, notePreview, RATINGS, STATE_LABELS, type Confidence } from '#lib/cards.js';
	import { durationLabel, relativeTime } from '#lib/dates.js';
	import type { ReviewCard } from '#lib/server/cards.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Start from the server's data (correct on first paint); reassigned locally as you review.
	let card = $derived<ReviewCard | null>(data.card);
	let counts = $derived(data.counts);
	let nextLearning = $derived<number | null>(data.nextLearningDue);
	let revealed = $state(false);
	let confidence = $state<Confidence | null>(null);
	let shownAt = $state(Date.now());
	let submitting = $state(false);
	let seen = $state<string[]>([]);

	// This session's numbers.
	let done = $state(0);
	let correct = $state(0);
	let luckyGuesses = $state(0);
	let totalMs = $state(0);
	let startedAt = $state(Date.now());
	let now = $state(Date.now());

	let editorOpen = $state(false);
	let editorDraft = $state<CardDraft>({ kind: 'basic', fields: {}, aamcCode: null, tags: [] });
	let mistakeOpen = $state(false);
	let mistakeDraft = $state<MistakeDraft>(emptyMistake());

	const limitReached = $derived(data.limit !== null && done >= data.limit);
	const remaining = $derived(counts.total);
	const goal = $derived(data.limit ?? done + remaining);
	const pct = $derived(goal ? Math.min(100, Math.round((done / goal) * 100)) : 100);
	const minsLeft = $derived(Math.max(1, Math.round(((data.limit ? Math.max(0, data.limit - done) : remaining) * data.secondsPerCard) / 60)));
	const elapsed = $derived(Math.round((now - startedAt) / 1000));

	// The deck, category or book being studied: sent with every request so the next
	// card always comes from the same place.
	const filterQuery = $derived.by(() => {
		const p = new URLSearchParams();
		if (data.filter.aamcCode) p.set('aamc', data.filter.aamcCode);
		if (data.filter.documentId) p.set('doc', data.filter.documentId);
		if (data.filter.deck) p.set('deck', data.filter.deck);
		if (data.filter.only) p.set('only', data.filter.only);
		return p.toString();
	});

	function show(next: ReviewCard | null) {
		card = next;
		revealed = false;
		confidence = null;
		shownAt = Date.now();
	}

	function reveal() {
		if (!card || revealed) return;
		revealed = true;
	}

	async function rate(rating: number) {
		if (!card || !revealed || submitting) return;
		submitting = true;
		const current = card;
		const timeTakenMs = Date.now() - shownAt;
		try {
			const r = await api<{
				result: { status: 'saved' | 'duplicate' | 'conflict' };
				card: ReviewCard | null;
				counts: typeof counts;
				nextLearningDue: number | null;
			}>('/api/review', {
				body: {
					cardId: current.cardId,
					rating,
					confidence,
					eventId: current.eventId,
					timeTakenMs,
					deviceId: deviceId(),
					deviceSeq: nextDeviceSeq(),
					baseRev: current.rev,
					exclude: seen,
					aamc: data.filter.aamcCode,
					doc: data.filter.documentId,
					deck: data.filter.deck,
					only: data.filter.only
				}
			});
			if (r.result.status === 'conflict') {
				toast('That card was just reviewed somewhere else, so this answer wasn’t saved.');
			} else if (r.result.status === 'saved') {
				done++;
				if (rating > 1) correct++;
				if (rating > 1 && confidence === 'guess') luckyGuesses++;
				totalMs += Math.min(timeTakenMs, 60_000);
			}
			counts = r.counts;
			nextLearning = r.nextLearningDue;
			show(r.card);
			if (!r.card || (data.limit !== null && done >= data.limit)) void finishInSession();
		} catch (err) {
			toastError(err);
		} finally {
			submitting = false;
		}
	}

	async function finishInSession() {
		if (data.session && data.itemId) {
			await api(`/api/session/${data.session.id}`, { body: { itemId: data.itemId, done: true } }).catch(() => {});
		}
		// The session bar picks up the next item.
		void invalidate('app:shell');
	}

	async function suspend() {
		if (!card) return;
		try {
			await api('/api/cards', { method: 'PATCH', body: { cardId: card.cardId, suspended: true } });
			toast('Card suspended. Find it under Flashcards › Suspended.');
			const r = await api<{ card: ReviewCard | null; counts: typeof counts; nextLearningDue: number | null }>(
				`/api/review?exclude=${seen.join(',')}${filterQuery ? `&${filterQuery}` : ''}`
			);
			counts = r.counts;
			nextLearning = r.nextLearningDue;
			show(r.card);
		} catch (err) {
			toastError(err);
		}
	}

	function openEditor() {
		if (!card) return;
		editorDraft = {
			kind: card.kind,
			fields: { ...card.fields },
			aamcCode: card.aamcCode,
			tags: [...card.tags],
			fieldNames: card.anki?.fieldNames ?? null,
			noteTypeName: card.anki?.noteType ?? null
		};
		editorOpen = true;
	}

	async function markFixed() {
		if (!card) return;
		try {
			await api('/api/cards', { method: 'PATCH', body: { cardId: card.cardId, leech: false } });
			card = { ...card, leech: false };
			toast('Leech flag cleared. It comes back only if the card keeps being forgotten.');
		} catch (err) {
			toastError(err);
		}
	}

	async function reloadCurrent() {
		if (!card) return;
		const current = card;
		try {
			const r = await api<{ card: ReviewCard | null }>(`/api/review?card=${current.cardId}`);
			if (r.card) card = { ...r.card, eventId: current.eventId };
			else show(null);
		} catch (err) {
			toastError(err);
		}
	}

	function logMistake() {
		if (!card) return;
		mistakeDraft = emptyMistake({
			sourceType: 'card',
			cardId: card.cardId,
			aamcCode: card.aamcCode,
			summary: notePreview(card.kind, card.fields, 300),
			links: card.source ? [{ kind: 'anchor', refId: card.source.id }] : []
		});
		mistakeOpen = true;
	}

	// Focus mode (Settings › Appearance): only the card, no sidebar, stats or decorations.
	const focus = $derived(appearance.account.focusMode);
	$effect(() => {
		appearance.focus = focus;
		return () => (appearance.focus = false);
	});

	onMount(() => {
		const stop = trackActivity('review');
		const clock = setInterval(() => (now = Date.now()), 1000);
		const onKey = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement;
			if (editorOpen || mistakeOpen || t.closest('input, textarea, select, [contenteditable]')) return;
			if ((e.key === ' ' || e.key === 'Enter') && !revealed) {
				e.preventDefault();
				reveal();
			} else if (revealed && ['1', '2', '3', '4'].includes(e.key)) {
				e.preventDefault();
				void rate(Number(e.key));
			}
		};
		window.addEventListener('keydown', onKey);
		return () => {
			stop();
			clearInterval(clock);
			window.removeEventListener('keydown', onKey);
			void invalidate('app:shell');
		};
	});

	const sourceHref = $derived(card?.source ? `/library/${card.source.documentId}/read?anchor=${card.source.id}` : null);
</script>

<svelte:head><title>Review · Medicus Vitae</title></svelte:head>

<div class="page" class:focus>
	<header class="page-header" style="align-items: center">
		<div>
			<div class="eyebrow">{data.filterLabel ? `Studying: ${data.filterLabel}` : 'All due cards'}</div>
			{#if !focus}<h1>Flashcards</h1>{/if}
		</div>
		<div class="row-tight">
			{#if !focus}
				<span class="pill pill-accent">New {counts.new}</span>
				<span class="pill">Learning {counts.learning}</span>
				<span class="pill">Review {counts.review}</span>
			{/if}
			<a class="btn" class:btn-sm={focus} href={data.session ? `/session/${data.session.id}` : '/'}>{data.session ? 'Session plan' : 'Done for now'}</a>
		</div>
	</header>

	<div hidden={focus}>
		<div class="row small muted" style="justify-content: space-between; margin-bottom: 6px">
			<span><span class="mono strong" style="color: var(--text)">{done}</span> of {goal} reviewed</span>
			{#if !limitReached && card}<span>About {minsLeft} min left</span>{/if}
		</div>
		<div class="bar"><span style="width: {pct}%"></span></div>
	</div>

	<div class="columns">
		<section class="card review-card" aria-label="Current card">
			{#if card && !limitReached}
				<div class="row-tight">
					{#if card.aamcCode}<CodeTag code={card.aamcCode} /><span class="topic-tag">{CATEGORY_SHORT[card.aamcCode] ?? ''}</span>{/if}
					<span class="topic-tag">{STATE_LABELS[card.state]}</span>
					{#if card.deck}<span class="topic-tag" title="Anki deck: {card.deck.split('::').join(' › ')}">{card.deck.split('::').pop()}</span>{/if}
				</div>
				{#if card.leech}
					<div class="warning leech" role="status">
						<Icon name="alert" size={18} />
						<div>
							<strong>Leech.</strong> You’ve forgotten this card {card.lapses} times. Rewording it or splitting it into smaller cards usually helps; its schedule hasn’t been changed.
							<div class="row-tight" style="margin-top: 0.5rem">
								<button type="button" class="btn btn-sm" onclick={openEditor}>Edit card</button>
								<button type="button" class="btn btn-sm btn-ghost" onclick={markFixed}>Mark as fixed</button>
							</div>
						</div>
					</div>
				{/if}
				{#if card.source?.kind === 'region' && card.source.available}
					<RegionImage documentId={card.source.documentId} page={card.source.page} rect={card.source.rects[0]} alt="Figure this card was made from" />
				{/if}
				{#if card.anki}
					<!-- Anki's answer template repeats the front, so it replaces the question when revealed. -->
					<AnkiCard
						html={revealed ? card.back : card.front}
						css={card.anki.css}
						math={card.anki.math}
						ord={card.ord}
						mediaBase={card.anki.mediaBase}
						label={revealed ? 'Card answer' : 'Card question'}
						onreveal={reveal}
					/>
				{:else}
					<div class="md front">{@html card.front}</div>
				{/if}

				{#if !revealed}
					<div class="stack" style="margin-top: auto; gap: 1.375rem">
						<div>
							<div id="conf-label" class="label" style="margin-bottom: 0.625rem">How sure are you before you check?</div>
							<div role="group" aria-labelledby="conf-label" class="row-tight">
								{#each CONFIDENCE as c (c.code)}
									<button type="button" class="btn conf" aria-pressed={confidence === c.code} onclick={() => (confidence = confidence === c.code ? null : c.code)}>{c.label}</button>
								{/each}
							</div>
						</div>
						<button type="button" class="btn btn-navy btn-lg" style="align-self: flex-start" onclick={reveal}>Show answer <span class="kbd">Space</span></button>
					</div>
				{:else}
					<div class="stack" style="gap: 1.125rem">
						{#if !card.anki}
							<hr style="margin: 0" />
							<div class="md back">{@html card.back}</div>
						{/if}
						<div class="row-tight">
							{#if card.source}
								{#if card.source.available && sourceHref}
									<a class="source-chip" href={sourceHref}><Icon name="book" size={13} stroke={2} />{card.source.label}</a>
								{:else}
									<span class="source-chip missing" title={card.source.exact}><Icon name="alert" size={13} stroke={2} />Source missing · {card.source.label}</span>
								{/if}
							{/if}
							<span class="small muted">You said: <strong style="color: var(--text)">{confidence ? CONFIDENCE.find((c) => c.code === confidence)?.label : 'Not rated'}</strong></span>
							{#if data.ai}<a class="btn btn-sm btn-ghost" href="/tutor?card={card.cardId}" target="_blank" rel="noopener"><Icon name="sparkle" size={15} />Explain with tutor</a>{/if}
						</div>
						<div class="ratings">
							{#each RATINGS as r (r.value)}
								<button type="button" class="rate rate-{r.value}" disabled={submitting} onclick={() => rate(r.value)}>
									<span class="rate-label">{r.label}</span>
									<span class="rate-ivl mono">{card.intervals[r.value]}</span>
									<span class="kbd">{r.value}</span>
								</button>
							{/each}
						</div>
					</div>
				{/if}
			{:else}
				<div class="empty" style="margin: auto">
					<Icon name="check" size={36} />
					<h2>{limitReached ? 'Session goal reached' : 'All caught up'}</h2>
					<p>
						{#if limitReached}
							You did the {data.limit} cards planned for this session.
						{:else if nextLearning}
							More learning steps come back {relativeTime(nextLearning)}.
						{:else}
							No more cards are due today{data.filterLabel ? ' in this filter' : ''}.
						{/if}
					</p>
					<div class="row" style="justify-content: center">
						{#if data.session}<a class="btn btn-primary" href="/session/{data.session.id}/next{data.itemId ? `?after=${data.itemId}` : ''}">Next in your session<Icon name="arrow-right" size={16} /></a>{/if}
						{#if limitReached && counts.total}<a class="btn" href="/review{filterQuery ? `?${filterQuery}` : ''}">Keep going ({counts.total} left)</a>{/if}
						<a class="btn" href="/">Today</a>
					</div>
				</div>
			{/if}
		</section>

		<aside class="col-side" style="flex: 1 1 17.5rem" hidden={focus}>
			<div class="card card-tight">
				<h2>This session</h2>
				<div class="session-grid">
					<div><div class="tiny muted">Correct</div><div class="mono stat-sm">{done ? Math.round((correct / done) * 100) : 0}%</div></div>
					<div><div class="tiny muted">Avg per card</div><div class="mono stat-sm">{done ? Math.round(totalMs / done / 1000) : 0}s</div></div>
					<div><div class="tiny muted">Lucky guesses</div><div class="mono stat-sm">{luckyGuesses}</div></div>
					<div><div class="tiny muted">Time</div><div class="mono stat-sm">{durationLabel(elapsed)}</div></div>
				</div>
				<p class="small muted" style="margin-top: 0.875rem">
					“Lucky guesses” are cards you got right but marked Guess. Confidence is recorded for your stats; it doesn’t change when cards come back.
				</p>
			</div>
			{#if card && !limitReached}
				<div class="card card-tight">
					<h2>This card</h2>
					<div class="stack-sm small" style="margin-top: 0.75rem">
						<div class="row" style="justify-content: space-between"><span class="muted">Last seen</span><span>{card.lastReview ? relativeTime(card.lastReview) : 'New'}</span></div>
						<div class="row" style="justify-content: space-between"><span class="muted">Times forgotten</span><span class="mono">{card.lapses}</span></div>
						<div class="row" style="justify-content: space-between"><span class="muted">Reviews</span><span class="mono">{card.reps}</span></div>
						<div class="row" style="justify-content: space-between"><span class="muted">Scheduler</span><span>FSRS</span></div>
					</div>
					<div class="row-tight" style="margin-top: 1rem">
						<button type="button" class="btn btn-sm" onclick={openEditor}><Icon name="edit" size={16} />Edit card</button>
						<button type="button" class="btn btn-sm" onclick={logMistake}><Icon name="journal" size={16} />Log to mistake journal</button>
						<button type="button" class="btn btn-sm btn-ghost" onclick={suspend}>Suspend</button>
					</div>
				</div>
			{/if}
		</aside>
	</div>
</div>

<CardEditor bind:open={editorOpen} draft={editorDraft} noteId={card?.noteId ?? null} onsaved={() => void reloadCurrent()} />
<MistakeForm bind:open={mistakeOpen} draft={mistakeDraft} fullLengths={data.fullLengths} practiceSets={data.practiceSets} />

<style>
	/* Focus mode: the card alone, centered. */
	.page.focus {
		max-width: 56rem;
	}
	.review-card {
		flex: 999 1 30rem;
		min-width: 0;
		border-radius: var(--radius-xl);
		padding: 2.25rem 2.5rem;
		display: flex;
		flex-direction: column;
		gap: 1.375rem;
		min-height: 30rem;
	}
	@media (max-width: 700px) {
		.review-card {
			padding: 1.25rem;
			min-height: 24rem;
		}
	}
	.front {
		font-size: 1.625rem;
		line-height: 1.35;
		font-weight: 600;
		letter-spacing: -0.01em;
	}
	.back {
		font-size: 1.1875rem;
		line-height: 1.55;
		color: var(--text);
	}
	@media (max-width: 700px) {
		.front {
			font-size: 1.25rem;
		}
		.back {
			font-size: 1.0625rem;
		}
	}
	.leech {
		font-size: 0.875rem;
	}
	.conf[aria-pressed='true'] {
		background: var(--ink);
		border-color: var(--ink);
		color: var(--on-ink);
	}
	.ratings {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.625rem;
		margin-top: 0.5rem;
	}
	.rate {
		min-height: 64px;
		border-radius: 12px;
		border: 1px solid var(--border-strong);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 2px;
		position: relative;
	}
	.rate:hover {
		background: var(--surface-2);
	}
	.rate-1 {
		border-color: var(--weak-border);
		color: var(--weak-text);
	}
	.rate-3 {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}
	.rate-3:hover {
		background: var(--accent-hover);
	}
	.rate-label {
		font-size: 0.9375rem;
		font-weight: 700;
	}
	.rate-ivl {
		font-size: 0.75rem;
		color: var(--text-3);
	}
	.rate-3 .rate-ivl {
		color: var(--on-accent);
	}
	.kbd {
		font-family: var(--font-mono);
		font-size: 0.625rem;
		opacity: 0.6;
		border: 1px solid currentColor;
		border-radius: 4px;
		padding: 0 4px;
		margin-left: 0.25rem;
	}
	.rate .kbd {
		position: absolute;
		top: 6px;
		right: 8px;
		margin: 0;
	}
	@media (max-width: 700px) {
		.kbd {
			display: none;
		}
	}
	.session-grid {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 0.875rem;
		margin-top: 0.875rem;
	}
	.stat-sm {
		font-size: 1.375rem;
		font-weight: 600;
	}
</style>
