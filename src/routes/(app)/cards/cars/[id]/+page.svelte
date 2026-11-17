<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { api } from '#lib/client/api.js';
	import { appearance } from '#lib/client/appearance.svelte.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import { relativeTime } from '#lib/dates.js';
	import { addSpan, coversSpan, overlapsSpan, removeSpan, segments, type Span } from '#lib/text-marks.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const L = 'ABCDEF';
	type Attempt = (typeof data.attempts)[number];

	let phase = $state<'ready' | 'running' | 'review'>('ready');
	let layout = $state<'one' | 'all'>('one');
	let current = $state(0);
	let choices = $state<(number | null)[]>([]);
	let struck = $state<Record<string, boolean>>({});
	let paused = $state(false);
	let elapsed = $state(0);
	let perQuestion = $state<number[]>([]);
	let readingSeconds = $state(0);
	let startedAt = 0;
	let tick: ReturnType<typeof setInterval> | null = null;
	let shownAttempt = $state<Attempt | null>(null);
	let submitting = $state(false);

	onMount(() => {
		layout = data.layout;
		if (data.attempts.length) {
			shownAttempt = data.attempts[0];
			phase = 'review';
		}
	});
	onDestroy(() => {
		if (tick) clearInterval(tick);
		appearance.studying = false;
	});

	function start() {
		phase = 'running';
		choices = data.questions.map(() => null);
		perQuestion = data.questions.map(() => 0);
		struck = {};
		marks = {};
		hlBar = null;
		current = 0;
		elapsed = 0;
		readingSeconds = 0;
		paused = false;
		startedAt = Date.now();
		appearance.studying = true;
		if (tick) clearInterval(tick);
		tick = setInterval(() => {
			if (paused || phase !== 'running') return;
			elapsed++;
			if (choices.every((c) => c === null)) readingSeconds++;
			else if (layout === 'one') perQuestion[current] = (perQuestion[current] ?? 0) + 1;
			else perQuestion[lastTouched] = (perQuestion[lastTouched] ?? 0) + 1;
		}, 1000);
	}

	let lastTouched = 0;
	function choose(qi: number, ci: number) {
		if (phase !== 'running') return;
		choices[qi] = choices[qi] === ci ? null : ci;
		lastTouched = qi;
		struck[`${qi}:${ci}`] = false;
	}

	function strike(qi: number, ci: number, e?: Event) {
		e?.preventDefault();
		if (phase !== 'running') return;
		const k = `${qi}:${ci}`;
		struck[k] = !struck[k];
		if (struck[k] && choices[qi] === ci) choices[qi] = null;
	}

	const answered = $derived(choices.filter((c) => c !== null).length);

	async function submit() {
		if (answered < data.questions.length && !confirm(`${data.questions.length - answered} question${data.questions.length - answered === 1 ? ' is' : 's are'} unanswered. Submit anyway?`)) return;
		submitting = true;
		if (tick) clearInterval(tick);
		try {
			// Reading time with no answers yet is spread over the questions only for the per-question view.
			const r = await api<{ attempt: Attempt }>('/api/cars', {
				body: {
					action: 'attempt',
					passageId: data.passage.id,
					startedAt,
					seconds: elapsed,
					readingSeconds,
					answers: data.questions.map((q, i) => ({ questionId: q.id, choice: choices[i], seconds: perQuestion[i] ?? 0 }))
				}
			});
			appearance.studying = false;
			await invalidate('app:cars-passage');
			shownAttempt = r.attempt;
			phase = 'review';
			window.scrollTo({ top: 0 });
		} catch (err) {
			toastError(err);
			start();
		} finally {
			submitting = false;
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.ctrlKey || e.metaKey || e.altKey) return;
		const t = e.target as HTMLElement | null;
		if (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName)) return;
		if (e.key === 'Escape' && hlBar) {
			hlBar = null;
			return;
		}
		if (e.key.toLowerCase() === 'h' && phase !== 'ready') {
			if (toggleHighlight()) e.preventDefault();
			return;
		}
		if (phase !== 'running') return;
		const idx = L.toLowerCase().indexOf(e.key.toLowerCase());
		if (layout === 'one' && idx >= 0 && idx < (data.questions[current]?.choices.length ?? 0)) {
			e.preventDefault();
			choose(current, idx);
		} else if (layout === 'one' && (e.key === 'ArrowRight' || e.key === 'n')) {
			current = Math.min(data.questions.length - 1, current + 1);
		} else if (layout === 'one' && (e.key === 'ArrowLeft' || e.key === 'p')) {
			current = Math.max(0, current - 1);
		}
	}

	// Highlighting while reading (only for this try; not saved): character spans
	// per paragraph. Select text, then Highlight or H; select highlighted text and
	// Unhighlight or H again, or click a highlight to remove it.
	type Piece = { i: number; a: number; b: number };
	let passageEl: HTMLElement | undefined = $state();
	let marks = $state<Record<number, Span[]>>({});
	let hlBar = $state<{ x: number; y: number; below: boolean; pieces: Piece[]; add: boolean; remove: boolean } | null>(null);
	const hlCount = $derived(Object.values(marks).reduce((n, s) => n + s.length, 0));

	/** Characters before (node, offset) in paragraph p. */
	function textOffset(p: HTMLElement, node: Node, offset: number) {
		const r = document.createRange();
		r.setStart(p, 0);
		r.setEnd(node, offset);
		return r.toString().length;
	}

	/** The selected passage text, as a span in each paragraph it covers (spaces at the ends left out). */
	function selectedPieces(): { pieces: Piece[]; rect: DOMRect } | null {
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || !sel.rangeCount || !passageEl) return null;
		const range = sel.getRangeAt(0);
		const pieces: Piece[] = [];
		for (const p of passageEl.querySelectorAll<HTMLElement>('p[data-i]')) {
			if (!range.intersectsNode(p)) continue;
			const i = Number(p.dataset.i);
			const text = data.passage.paragraphs[i] ?? '';
			let a = p.contains(range.startContainer) ? textOffset(p, range.startContainer, range.startOffset) : 0;
			let b = p.contains(range.endContainer) ? textOffset(p, range.endContainer, range.endOffset) : text.length;
			while (a < b && /\s/.test(text[a])) a++;
			while (b > a && /\s/.test(text[b - 1])) b--;
			if (b > a) pieces.push({ i, a, b });
		}
		return pieces.length ? { pieces, rect: range.getBoundingClientRect() } : null;
	}

	const allHighlighted = (pieces: Piece[]) => pieces.every((p) => coversSpan(marks[p.i] ?? [], [p.a, p.b]));
	const anyHighlighted = (pieces: Piece[]) => pieces.some((p) => overlapsSpan(marks[p.i] ?? [], [p.a, p.b]));

	function setMarks(pieces: Piece[], on: boolean) {
		const next = { ...marks };
		for (const { i, a, b } of pieces) next[i] = on ? addSpan(next[i] ?? [], [a, b]) : removeSpan(next[i] ?? [], [a, b]);
		marks = next;
		window.getSelection()?.removeAllRanges();
		hlBar = null;
	}

	/** H: highlights the selection, or unhighlights it if it's all highlighted already. */
	function toggleHighlight(): boolean {
		const sel = selectedPieces();
		if (!sel) return false;
		setMarks(sel.pieces, !allHighlighted(sel.pieces));
		return true;
	}

	function showBar(rect: DOMRect, pieces: Piece[]) {
		if (!passageEl) return;
		const box = passageEl.getBoundingClientRect();
		const x = Math.min(Math.max(rect.left + rect.width / 2 - box.left, 70), box.width - 70);
		// Below the text when there's no room above it (under the sticky bar).
		const below = rect.top < 120;
		hlBar = { x, y: (below ? rect.bottom : rect.top) - box.top, below, pieces, add: !allHighlighted(pieces), remove: anyHighlighted(pieces) };
	}

	let pointerDown = false;
	function onPassagePointerUp(e: PointerEvent) {
		pointerDown = false;
		if (phase === 'ready' || (paused && phase === 'running')) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest('.hl-bar')) return;
		setTimeout(() => {
			const sel = selectedPieces();
			if (sel) return showBar(sel.rect, sel.pieces);
			// A click on a highlight: offer to remove it.
			const m = target?.closest<HTMLElement>('mark.hl');
			if (m) showBar(m.getBoundingClientRect(), [{ i: Number(m.dataset.i), a: Number(m.dataset.a), b: Number(m.dataset.b) }]);
		}, 0);
	}

	function onWindowPointerDown(e: PointerEvent) {
		if ((e.target as HTMLElement | null)?.closest('.hl-bar')) return;
		pointerDown = true;
		hlBar = null;
	}

	// Phones and keyboards select without a click: show the bar once the selection settles.
	let selTimer: ReturnType<typeof setTimeout> | null = null;
	function onSelectionChange() {
		if (selTimer) clearTimeout(selTimer);
		selTimer = setTimeout(() => {
			if (pointerDown || phase === 'ready' || (paused && phase === 'running')) return;
			const sel = selectedPieces();
			if (sel) showBar(sel.rect, sel.pieces);
		}, 300);
	}
	onMount(() => {
		document.addEventListener('selectionchange', onSelectionChange);
		return () => {
			document.removeEventListener('selectionchange', onSelectionChange);
			if (selTimer) clearTimeout(selTimer);
		};
	});

	function clearMarks() {
		marks = {};
		hlBar = null;
	}

	const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
	const result = $derived(shownAttempt);
	const answerFor = (qid: string) => result?.answers.find((a) => a.questionId === qid) ?? null;
	const noKey = $derived(data.questions.some((q) => q.answer === null));

	async function setKey(qid: string, answer: number | null) {
		try {
			await api('/api/cars', { body: { action: 'answer', questionId: qid, answer } });
			await invalidate('app:cars-passage');
			const fresh = data.attempts.find((a) => a.id === shownAttempt?.id);
			if (fresh) shownAttempt = fresh;
			toast('Answer key updated; tries rescored');
		} catch (err) {
			toastError(err);
		}
	}

	const SOURCE: Record<string, string> = { jackwestin: 'Jack Westin', aamc: 'AAMC', other: 'Pasted' };
</script>

<svelte:window onkeydown={onKey} onpointerdown={onWindowPointerDown} onpointerup={() => (pointerDown = false)} />
<svelte:head><title>{data.passage.title} · CARS · Medicus Vitae</title></svelte:head>

<div class="player" class:running={phase === 'running'}>
	<header class="bar-top">
		<a class="icon-btn plain sm" href="/cards/cars" aria-label="Back to CARS"><Icon name="chevron-left" size={18} /></a>
		<div class="t-main">
			<div class="strong truncate">{data.passage.title}</div>
			<div class="tiny muted truncate">
				{SOURCE[data.passage.source] ?? data.passage.source}{data.passage.topic ? ` · ${data.passage.topic}` : ''} · {data.passage.wordCount} words · {data.questions.length} questions
			</div>
		</div>
		{#if hlCount && phase !== 'ready'}
			<button type="button" class="btn btn-sm btn-ghost" onclick={clearMarks}>Clear highlights</button>
		{/if}
		{#if phase === 'running'}
			<div class="row-tight">
				<span class="timer mono" class:paused aria-live="off" title="Time on this passage">{clock(elapsed)}</span>
				<button type="button" class="icon-btn sm" aria-label={paused ? 'Resume' : 'Pause'} onclick={() => (paused = !paused)}><Icon name={paused ? 'play' : 'pause'} size={15} /></button>
				<button type="button" class="btn btn-sm btn-primary" disabled={submitting} onclick={submit}>{submitting ? 'Saving…' : `Submit · ${answered}/${data.questions.length}`}</button>
			</div>
		{:else if phase === 'review'}
			<div class="row-tight">
				{#if data.passage.sourceUrl}<a class="btn btn-sm btn-ghost" href={data.passage.sourceUrl} target="_blank" rel="noopener noreferrer">Original<Icon name="external" size={13} /></a>{/if}
				<button type="button" class="btn btn-sm" onclick={start}><Icon name="refresh" size={14} />Try again</button>
			</div>
		{/if}
	</header>

	{#if phase === 'ready'}
		<div class="ready card">
			<h1>{data.passage.title}</h1>
			<p class="muted">{data.passage.wordCount} words · {data.questions.length} questions{data.passage.publishedOn ? ` · ${data.passage.publishedOn}` : ''}</p>
			{#if !data.questions.length}
				<div class="warning small"><Icon name="info" size={15} />No questions came with this passage. You can still read it.</div>
			{:else if noKey}
				<div class="warning small"><Icon name="info" size={15} />No answer key yet: your answers are saved and scored once the key is added (press the bookmark on the site after submitting there, or set it by hand afterwards).</div>
			{/if}
			<div class="segmented" role="radiogroup" aria-label="Questions">
				<button type="button" role="radio" aria-checked={layout === 'one'} onclick={() => (layout = 'one')}>One at a time</button>
				<button type="button" role="radio" aria-checked={layout === 'all'} onclick={() => (layout = 'all')}>All at once</button>
			</div>
			<p class="hint">The timer starts when you press Start. Keys: A–D choose, ← → move, H highlights the selected text (H again, or click the highlight, to remove it). Right-click a choice to cross it out.</p>
			<button type="button" class="btn btn-primary btn-lg" style="align-self: flex-start" onclick={start}><Icon name="play" size={18} />Start</button>
		</div>
	{:else}
		{#if phase === 'review' && result}
			<div class="result card">
				<div class="r-num">
					<span class="mono big">{result.scored ? `${result.correct}/${result.scored}` : '—'}</span>
					<span class="small muted">{result.scored ? `${Math.round((result.correct / result.scored) * 100)}% correct` : 'no answer key'}</span>
				</div>
				<div class="r-num"><span class="mono big">{clock(result.seconds)}</span><span class="small muted">total · {clock(result.readingSeconds)} reading</span></div>
				<div class="r-num"><span class="mono big">{clock(result.total ? (result.seconds - result.readingSeconds) / result.total : 0)}</span><span class="small muted">per question</span></div>
				{#if data.attempts.length > 1}
					<label class="field" style="margin-left: auto">
						<span class="label">Try</span>
						<select class="select input-sm" value={result.id} onchange={(e) => (shownAttempt = data.attempts.find((a) => a.id === (e.currentTarget as HTMLSelectElement).value) ?? shownAttempt)}>
							{#each data.attempts as a, i (a.id)}<option value={a.id}>{relativeTime(a.finishedAt)} · {a.scored ? `${a.correct}/${a.scored}` : '—'}{i === 0 ? ' (latest)' : ''}</option>{/each}
						</select>
					</label>
				{/if}
			</div>
		{/if}

		<div class="split" class:paused={paused && phase === 'running'}>
			<article class="passage reading" bind:this={passageEl} onpointerup={onPassagePointerUp}>
				{#each data.passage.paragraphs as p, i (i)}<p data-i={i}>{#each segments(p, marks[i]) as s (s.start)}{#if s.hl}<mark class="hl" data-i={i} data-a={s.start} data-b={s.end}>{s.text}</mark>{:else}{s.text}{/if}{/each}</p>{/each}
				{#if hlBar}
					<div class="hl-bar" class:below={hlBar.below} role="toolbar" aria-label="Highlight" tabindex="-1" style="left: {hlBar.x}px; top: {hlBar.y}px" onmousedown={(e) => e.preventDefault()}>
						{#if hlBar.add}<button type="button" onclick={() => setMarks(hlBar!.pieces, true)}><span class="swatch"></span>Highlight</button>{/if}
						{#if hlBar.remove}<button type="button" onclick={() => setMarks(hlBar!.pieces, false)}>Unhighlight</button>{/if}
					</div>
				{/if}
				{#if paused && phase === 'running'}<div class="pause-cover"><button type="button" class="btn btn-primary" onclick={() => (paused = false)}><Icon name="play" size={16} />Resume</button></div>{/if}
			</article>

			<section class="questions" aria-label="Questions">
				{#if phase === 'running' && layout === 'one'}
					<nav class="palette" aria-label="Question list">
						{#each data.questions as q, i (q.id)}
							<button type="button" class:on={current === i} class:done={choices[i] !== null} onclick={() => (current = i)} aria-label="Question {i + 1}{choices[i] !== null ? ', answered' : ''}">{i + 1}</button>
						{/each}
					</nav>
				{/if}
				{#each data.questions as q, qi (q.id)}
					{#if phase !== 'running' || layout === 'all' || qi === current}
						{@const a = phase === 'review' ? answerFor(q.id) : null}
						<div class="q" class:right={a?.correct === true} class:wrong={a?.correct === false}>
							<div class="q-head">
								<span class="q-num mono">{qi + 1}</span>
								<div class="q-stem">{q.stem}</div>
								{#if a}<span class="tiny muted mono" title="Time on this question">{clock(a.seconds)}</span>{/if}
							</div>
							<ol class="choices">
								{#each q.choices as c, ci (ci)}
									{@const picked = phase === 'review' ? a?.choice === ci : choices[qi] === ci}
									{@const isKey = phase === 'review' && q.answer === ci}
									<li>
										<button
											type="button"
											class="choice"
											class:picked
											class:key={isKey}
											class:miss={phase === 'review' && picked && q.answer !== null && !isKey}
											class:struck={phase === 'running' && struck[`${qi}:${ci}`]}
											disabled={phase !== 'running'}
											onclick={() => choose(qi, ci)}
											oncontextmenu={(e) => strike(qi, ci, e)}
										>
											<span class="letter mono">{L[ci]}</span>
											<span class="c-text">{c}</span>
											{#if isKey}<Icon name="check" size={15} />{/if}
										</button>
									</li>
								{/each}
							</ol>
							{#if phase === 'review'}
								{#if q.explanation}
									<details class="explain" open={a?.correct === false}>
										<summary class="small strong">Explanation</summary>
										<div class="small reading">{q.explanation}</div>
									</details>
								{/if}
								{#if q.answer === null}
									<label class="row-tight small key-set">
										<span class="muted">Correct answer:</span>
										<select class="select input-sm" style="width: auto" onchange={(e) => setKey(q.id, (e.currentTarget as HTMLSelectElement).value === '' ? null : Number((e.currentTarget as HTMLSelectElement).value))}>
											<option value="">Not known</option>
											{#each q.choices as _c, ci (ci)}<option value={ci}>{L[ci]}</option>{/each}
										</select>
									</label>
								{/if}
							{/if}
						</div>
					{/if}
				{/each}
				{#if phase === 'running' && layout === 'one'}
					<div class="row" style="justify-content: space-between">
						<button type="button" class="btn btn-sm" disabled={current === 0} onclick={() => (current = Math.max(0, current - 1))}><Icon name="arrow-left" size={14} />Previous</button>
						{#if current < data.questions.length - 1}
							<button type="button" class="btn btn-sm" onclick={() => (current = current + 1)}>Next<Icon name="arrow-right" size={14} /></button>
						{:else}
							<button type="button" class="btn btn-sm btn-primary" disabled={submitting} onclick={submit}>Submit</button>
						{/if}
					</div>
				{/if}
				{#if !data.questions.length}<p class="small muted">No questions for this passage.</p>{/if}
			</section>
		</div>
	{/if}
</div>

<style>
	.player {
		display: flex;
		flex-direction: column;
		min-height: 100vh;
	}
	.bar-top {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.5rem 1rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
		position: sticky;
		top: 0;
		z-index: 5;
	}
	@media (max-width: 900px) {
		.bar-top {
			top: 49px;
		}
	}
	.t-main {
		flex: 1 1 auto;
		min-width: 0;
	}
	.timer {
		font-size: 0.9375rem;
		font-weight: 600;
		padding: 0 0.375rem;
	}
	.timer.paused {
		color: var(--text-3);
	}
	.ready {
		margin: 2rem auto;
		width: min(40rem, calc(100% - 2rem));
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.result {
		margin: 1rem 1rem 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 1.5rem;
		padding: 0.875rem 1.25rem;
	}
	.r-num {
		display: flex;
		flex-direction: column;
	}
	.big {
		font-size: 1.375rem;
		font-weight: 600;
	}
	.split {
		display: grid;
		grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
		gap: 0;
		flex: 1 1 auto;
		min-height: 0;
	}
	@media (max-width: 960px) {
		.split {
			grid-template-columns: 1fr;
		}
	}
	.passage {
		padding: 1.25rem 1.75rem 2rem;
		border-right: 1px solid var(--border);
		font-size: 1rem;
		max-width: 48rem;
		position: relative;
	}
	.passage p {
		margin: 0 0 1em;
	}
	.passage :global(mark.hl) {
		background: var(--hl-yellow);
		color: inherit;
		border-radius: 2px;
		cursor: pointer;
	}
	.hl-bar {
		position: absolute;
		z-index: 4;
		transform: translate(-50%, calc(-100% - 8px));
		display: flex;
		gap: 2px;
		padding: 4px;
		background: var(--ink);
		border-radius: 10px;
		box-shadow: var(--shadow-lg);
		white-space: nowrap;
		font-family: var(--font-ui);
		user-select: none;
	}
	.hl-bar.below {
		transform: translate(-50%, 8px);
	}
	.hl-bar button {
		min-height: 34px;
		padding: 0 0.75rem;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--on-ink);
		font-size: 0.8125rem;
		font-weight: 600;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}
	.hl-bar button:hover,
	.hl-bar button:focus-visible {
		background: var(--ink-hover);
	}
	.hl-bar .swatch {
		width: 12px;
		height: 12px;
		border-radius: 3px;
		background: var(--hl-yellow);
	}
	.split.paused .passage p,
	.split.paused .questions {
		filter: blur(6px);
		pointer-events: none;
		user-select: none;
	}
	.pause-cover {
		position: absolute;
		inset: 0;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		padding-top: 6rem;
	}
	.questions {
		padding: 1rem 1.5rem 2rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
	}
	.palette {
		display: flex;
		flex-wrap: wrap;
		gap: 0.25rem;
	}
	.palette button {
		width: 2rem;
		height: 2rem;
		border-radius: var(--radius-sm);
		border: 1px solid var(--border-strong);
		background: var(--surface);
		font-family: var(--font-mono);
		font-size: 0.75rem;
		cursor: pointer;
		color: var(--text-2);
	}
	.palette button.done {
		background: var(--surface-2);
		color: var(--text);
	}
	.palette button.on {
		border-color: var(--accent);
		box-shadow: 0 0 0 1px var(--accent);
		color: var(--accent-text);
	}
	.q {
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding-bottom: 1rem;
		border-bottom: 1px solid var(--border);
	}
	.q-head {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
	}
	.q-num {
		flex: none;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 4px;
		background: var(--surface-2);
		font-size: 0.75rem;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-weight: 600;
	}
	.q.right .q-num {
		background: var(--accent-soft);
		color: var(--accent-text);
	}
	.q.wrong .q-num {
		background: var(--weak-soft);
		color: var(--weak-text);
	}
	.q-stem {
		flex: 1 1 auto;
		font-weight: 600;
		line-height: 1.45;
	}
	.choices {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.choice {
		width: 100%;
		display: flex;
		align-items: flex-start;
		gap: 0.625rem;
		text-align: left;
		padding: 0.5rem 0.625rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
		line-height: 1.45;
	}
	.choice:hover:not(:disabled) {
		border-color: var(--border-strong);
	}
	.choice:disabled {
		cursor: default;
	}
	.choice.picked {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.choice.key {
		border-color: var(--accent);
		box-shadow: inset 3px 0 0 var(--accent);
	}
	.choice.miss {
		border-color: var(--weak);
		background: var(--weak-soft);
	}
	.choice.struck .c-text {
		text-decoration: line-through;
		color: var(--text-3);
	}
	.letter {
		flex: none;
		font-weight: 700;
		font-size: 0.75rem;
		width: 1.25rem;
		color: var(--text-2);
		padding-top: 0.125rem;
	}
	.c-text {
		flex: 1 1 auto;
	}
	.explain summary {
		cursor: pointer;
		color: var(--accent-text);
	}
	.explain .reading {
		margin-top: 0.375rem;
		white-space: pre-line;
		color: var(--text-2);
	}
	.key-set {
		margin-top: 0.25rem;
	}
</style>
