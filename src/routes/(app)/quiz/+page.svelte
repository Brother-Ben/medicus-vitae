<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import Icon from '#lib/components/Icon.svelte';
	import TutorTabs from '#lib/components/TutorTabs.svelte';
	import { trackActivity } from '#lib/client/activity.js';
	import { api } from '#lib/client/api.js';
	import { toastError } from '#lib/client/toast.svelte.js';
	import { renderMarkdown } from '#lib/markdown.js';
	import { onMount } from 'svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let index = $state(0);
	let picked = $state<number | null>(null);
	let result = $state<{ correct: boolean; answer: number; explanation: string } | null>(null);
	let shownAt = $state(Date.now());
	let right = $state(0);
	let answered = $state(0);

	const q = $derived(data.questions[index] ?? null);

	async function answer(choice: number) {
		if (!q || result) return;
		picked = choice;
		try {
			result = await api('/api/quiz', { body: { questionId: q.id, choice, timeMs: Date.now() - shownAt } });
			answered++;
			if (result!.correct) right++;
		} catch (err) {
			picked = null;
			toastError(err);
		}
	}

	async function next() {
		picked = null;
		result = null;
		shownAt = Date.now();
		if (index + 1 < data.questions.length) index++;
		else {
			index = 0;
			await invalidate('app:quiz');
		}
	}

	onMount(() => trackActivity('practice'));
</script>

<svelte:head><title>Quiz · Medicus Vitae</title></svelte:head>

<div class="page narrow">
	<header class="page-header">
		<div>
			<h1>Quiz</h1>
			<p class="subtitle">Questions you approved. Answers count as applied practice on your Progress heatmap.</p>
		</div>
	</header>
	<TutorTabs current="quiz" pending={data.pending} quizCount={data.total} />

	{#if data.books.length > 1}
		<div class="row-tight">
			<label for="quiz-book" class="small muted">Book</label>
			<select id="quiz-book" class="select" style="width: 16rem" value={data.documentId ?? ''} onchange={(e) => goto(e.currentTarget.value ? `/quiz?doc=${e.currentTarget.value}` : '/quiz')}>
				<option value="">All books</option>
				{#each data.books as b (b.id)}<option value={b.id}>{b.title}</option>{/each}
			</select>
		</div>
	{/if}

	{#if !q}
		<div class="card empty">
			<Icon name="quiz" size={32} />
			<h2>No questions yet</h2>
			<p>Generate quiz questions from a chapter on its book page, then approve them under Approvals.</p>
		</div>
	{:else}
		<section class="card stack quiz">
			<div class="row" style="justify-content: space-between">
				<div class="row-tight">
					{#if q.aamcCode}<span class="code-tag">{q.aamcCode}</span>{/if}
					{#if q.ai}<span class="pill pill-sm"><Icon name="sparkle" size={12} stroke={2} />AI-made, approved by you</span>{/if}
				</div>
				<span class="small muted mono">{answered ? `${right}/${answered} right` : ''}</span>
			</div>
			<div class="md stem">{@html renderMarkdown(q.stem)}</div>
			<div class="choices" role="group" aria-label="Choices">
				{#each q.choices as ch, n (n)}
					<button
						type="button"
						class="choice"
						class:right={result && result.answer === n}
						class:wrong={result && picked === n && !result.correct}
						disabled={!!result}
						onclick={() => answer(n)}
					>
						<span class="letter mono">{'ABCD'[n]}</span><span>{ch}</span>
						{#if result && result.answer === n}<Icon name="check" size={18} />{/if}
					</button>
				{/each}
			</div>
			{#if result}
				<div class={result.correct ? 'notice' : 'warning'}>
					<Icon name={result.correct ? 'check' : 'info'} size={18} />
					<div>
						<strong>{result.correct ? 'Right.' : `Not quite. The answer is ${'ABCD'[result.answer]}.`}</strong>
						{#if result.explanation}<div class="md small" style="margin-top: 0.25rem">{@html renderMarkdown(result.explanation)}</div>{/if}
					</div>
				</div>
				<div class="row" style="justify-content: space-between">
					{#if q.source}
						{#if q.source.href}<a class="source-chip" href={q.source.href}><Icon name="book" size={13} stroke={2} />{q.source.label}</a>{:else}<span class="source-chip missing">Source missing · {q.source.label}</span>{/if}
					{:else}<span></span>{/if}
					<button type="button" class="btn btn-primary" onclick={next}>Next question<Icon name="arrow-right" size={16} /></button>
				</div>
			{/if}
		</section>
	{/if}
</div>

<style>
	.narrow {
		max-width: 48rem;
	}
	.stem {
		font-size: 1.125rem;
		line-height: 1.5;
	}
	.choices {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.choice {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		min-height: 48px;
		padding: 0.625rem 0.875rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		text-align: left;
		font: inherit;
		cursor: pointer;
	}
	.choice:hover:not(:disabled) {
		background: var(--surface-2);
	}
	.choice:disabled {
		cursor: default;
	}
	.choice span:nth-child(2) {
		flex: 1;
	}
	.choice.right {
		border-color: var(--accent);
		background: var(--accent-soft);
		color: var(--accent-text);
	}
	.choice.wrong {
		border-color: var(--weak-border);
		background: var(--weak-soft);
		color: var(--weak-text);
	}
	.letter {
		font-weight: 700;
		width: 1.5rem;
	}
</style>
