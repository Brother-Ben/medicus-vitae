<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { api, ApiError } from '#lib/client/api.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import { relativeTime } from '#lib/dates.js';
	import { renderMarkdown } from '#lib/markdown.js';
	import type { Insight } from '#lib/server/ai/insights.js';
	import Icon from './Icon.svelte';

	// The AI coach on Today. Nothing runs until you press a button (each request
	// uses your AI allowance); the last answer of each kind is kept.

	type Tab = 'suggest' | 'recap' | 'mistakes' | 'chapter';
	let {
		insights,
		books
	}: {
		insights: { recap: Insight | null; suggest: Insight | null; mistakes: Insight | null; chapter: Insight | null };
		books: { id: string; title: string; sections: { id: string; title: string; level: number; pageStart: number; pageEnd: number }[] }[];
	} = $props();

	let tab = $state<Tab>('suggest');
	let busy = $state<Tab | null>(null);
	let local = $state<Partial<Record<Tab, Insight>>>({});
	let errorFor = $state<Partial<Record<Tab, { message: string; manageUrl: string | null }>>>({});
	const shown = (t: Tab) => local[t] ?? insights[t] ?? null;

	let bookId = $state('');
	let sectionId = $state('');
	const book = $derived(books.find((b) => b.id === bookId) ?? null);

	async function run(kind: Tab) {
		busy = kind;
		errorFor = { ...errorFor, [kind]: undefined };
		try {
			const r = await api<{ insight: Insight }>('/api/insights', { body: kind === 'chapter' ? { kind, sectionId } : { kind } });
			local = { ...local, [kind]: r.insight };
		} catch (err) {
			errorFor = { ...errorFor, [kind]: { message: err instanceof Error ? err.message : String(err), manageUrl: err instanceof ApiError ? ((err.data?.manageUrl as string | null) ?? null) : null } };
		} finally {
			busy = null;
		}
	}

	interface Suggestion {
		title: string;
		why: string;
		kind: string;
		aamcCode: string | null;
		minutes: number;
	}
	const suggestions = $derived(((shown('suggest')?.data.items as Suggestion[] | undefined) ?? []).filter((s) => s.title));

	function hrefFor(s: Suggestion) {
		switch (s.kind) {
			case 'reviews':
				return s.aamcCode ? `/review?aamc=${s.aamcCode}&only=due` : '/review?only=due';
			case 'new':
				return s.aamcCode ? `/review?aamc=${s.aamcCode}&only=new` : '/review?only=new';
			case 'category':
				return s.aamcCode ? `/review?aamc=${s.aamcCode}` : '/cards';
			case 'mistakes':
				return '/mistakes';
			case 'reading':
				return '/library';
			case 'full_length':
				return '/progress';
			default:
				return null;
		}
	}

	/** Turns the suggestions into a session (cards by category, your own tasks for the rest). */
	async function makeSession() {
		const uid = () => crypto.randomUUID?.() ?? String(Math.random()).slice(2);
		const items = suggestions
			.filter((s) => s.kind !== 'rest')
			.map((s) => {
				if (s.kind === 'reviews' || s.kind === 'new' || s.kind === 'category') {
					const fresh = s.kind === 'new';
					const count = Math.max(5, Math.round((s.minutes * 60) / (fresh ? 20 : 10)));
					return { id: uid(), type: fresh ? 'new' : 'reviews', title: s.title, detail: `${count} cards · about ${s.minutes} min`, why: s.why, minutes: s.minutes, count, aamcCode: s.aamcCode };
				}
				return { id: uid(), type: 'custom', title: s.title, detail: `About ${s.minutes} min`, why: s.why, minutes: s.minutes };
			});
		if (!items.length) return;
		try {
			const options = await api<{ prefs: { useTimer: boolean; focusMinutes: number; shortBreakMinutes: number; longBreakMinutes: number; roundsBeforeLong: number; autoStartBreaks: boolean; autoStartFocus: boolean } }>('/api/session');
			const r = await api<{ id: string }>('/api/session', {
				body: { budgetMinutes: items.reduce((a, i) => a + i.minutes, 0), title: 'Coach’s plan', items, focus: options.prefs.useTimer ? options.prefs : null }
			});
			await invalidate('app:shell');
			await goto(`/session/${r.id}/next`);
		} catch (err) {
			toastError(err);
		}
	}

	async function saveNote() {
		const c = shown('chapter');
		if (!c) return;
		try {
			await api('/api/insights', { body: { action: 'save-note', id: c.id } });
			local = { ...local, chapter: { ...c, data: { ...c.data, savedNoteId: 'saved' } } };
			toast('Saved to your notes');
		} catch (err) {
			toastError(err);
		}
	}

	const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
	type Cite = { n: number; page: number | null; documentId: string | null; anchorId: string | null; label: string };
	const cites = (v: unknown): Cite[] => (Array.isArray(v) ? (v as Cite[]) : []);
	type Pattern = { pattern: string; evidence: string; fix: string };
	const patterns = (v: unknown): Pattern[] => (Array.isArray(v) ? (v as Pattern[]) : []);

	const TABS: [Tab, string][] = [
		['suggest', 'What to work on'],
		['recap', 'Weekly recap'],
		['mistakes', 'Mistake patterns'],
		['chapter', 'Chapter summary']
	];
	const BUTTON: Record<Tab, string> = { suggest: 'Suggest what to do', recap: 'Write my recap', mistakes: 'Find patterns', chapter: 'Summarize' };
</script>

<section class="card coach" aria-labelledby="coach-h">
	<div class="card-header">
		<h2 id="coach-h" style="display: inline-flex; gap: 0.5rem; align-items: center"><Icon name="sparkle" size={18} />AI coach</h2>
		<span class="small muted">Runs only when you press a button</span>
	</div>
	<div class="segmented" role="tablist" aria-label="AI coach" style="margin-top: 0.75rem">
		{#each TABS as [id, label] (id)}
			<button type="button" role="tab" aria-selected={tab === id} onclick={() => (tab = id)}>{label}</button>
		{/each}
	</div>

	<div class="coach-body" role="tabpanel">
		{#if tab === 'chapter'}
			{#if books.length}
				<div class="row-tight">
					<label for="coach-book" class="sr-only">Book</label>
					<select id="coach-book" class="select" style="flex: 1 1 12rem; width: auto; min-height: 40px" bind:value={bookId} onchange={() => (sectionId = '')}>
						<option value="" disabled>Pick a book</option>
						{#each books as b (b.id)}<option value={b.id}>{b.title}</option>{/each}
					</select>
					{#if book}
						<label for="coach-ch" class="sr-only">Chapter</label>
						<select id="coach-ch" class="select" style="flex: 1 1 14rem; width: auto; min-height: 40px" bind:value={sectionId}>
							<option value="" disabled>Pick a chapter</option>
							{#each book.sections as s (s.id)}<option value={s.id}>{'  '.repeat(s.level)}{s.title} (p. {s.pageStart}–{s.pageEnd})</option>{/each}
						</select>
					{/if}
					<button type="button" class="btn btn-navy btn-sm" disabled={!sectionId || busy === 'chapter'} onclick={() => run('chapter')}>{busy === 'chapter' ? 'Summarizing…' : 'Summarize'}</button>
				</div>
			{:else}
				<p class="small muted">Import a book with chapters first.</p>
			{/if}
		{/if}

		{#if errorFor[tab]}
			<div class="error-box"><Icon name="alert" size={18} /><span>{errorFor[tab]!.message} {#if errorFor[tab]!.manageUrl}<a href={errorFor[tab]!.manageUrl}>Manage</a>{/if}</span></div>
		{/if}

		{#if shown(tab)}
			{@const ins = shown(tab)!}
			<div class="tiny muted">Made {relativeTime(ins.createdAt)}{ins.model ? ` · ${ins.model}` : ''}</div>
			{#if tab === 'suggest'}
				{#if ins.data.summary}<p>{ins.data.summary}</p>{/if}
				<ol class="sugg">
					{#each suggestions as s, i (i)}
						{@const href = hrefFor(s)}
						<li>
							<div style="flex: 1 1 auto; min-width: 0">
								<div class="strong">{s.title} <span class="tiny muted mono">· {s.minutes} min</span></div>
								<div class="small muted">{s.why}</div>
							</div>
							{#if href}<a class="btn btn-sm" {href}>Start</a>{/if}
						</li>
					{/each}
				</ol>
				{#if suggestions.length}
					<div><button type="button" class="btn btn-primary btn-sm" onclick={makeSession}><Icon name="play" size={16} />Make this my session</button></div>
				{/if}
			{:else if tab === 'recap'}
				<h3>{ins.data.headline}</h3>
				<p>{ins.data.summary}</p>
				<div class="two">
					{#if list(ins.data.wins).length}
						<div><div class="tiny strong muted">Went well</div><ul>{#each list(ins.data.wins) as w, i (i)}<li>{w}</li>{/each}</ul></div>
					{/if}
					{#if list(ins.data.watch).length}
						<div><div class="tiny strong muted">Keep an eye on</div><ul>{#each list(ins.data.watch) as w, i (i)}<li>{w}</li>{/each}</ul></div>
					{/if}
				</div>
			{:else if tab === 'mistakes'}
				{#if ins.data.summary}<p>{ins.data.summary}</p>{/if}
				{#each patterns(ins.data.patterns) as p, i (i)}
					<div class="pattern">
						<div class="strong">{p.pattern}</div>
						<div class="small muted">{p.evidence}</div>
						<div class="small"><strong>Try:</strong> {p.fix}</div>
					</div>
				{/each}
			{:else}
				<div class="tiny strong">{ins.data.bookTitle} · {ins.data.section} (pp. {ins.data.pageStart}–{ins.data.pageEnd})</div>
				<div class="md">{@html renderMarkdown(ins.text)}</div>
				{#if list(ins.data.keyTerms).length}
					<div class="row-tight">{#each list(ins.data.keyTerms) as k, i (i)}<span class="topic-tag">{k}</span>{/each}</div>
				{/if}
				{#if cites(ins.data.citations).length}
					<div class="row-tight">
						{#each cites(ins.data.citations) as c (c.n)}
							<a class="source-chip" href={c.anchorId ? `/library/${c.documentId}/read?anchor=${c.anchorId}` : `/library/${c.documentId}/read?page=${c.page ?? 1}`}>[{c.n}] p. {c.page}</a>
						{/each}
					</div>
				{/if}
				<div>
					{#if ins.data.savedNoteId}
						<span class="small muted"><Icon name="check" size={14} /> Saved to Notes</span>
					{:else}
						<button type="button" class="btn btn-sm" onclick={saveNote}><Icon name="note" size={16} />Save as a note</button>
					{/if}
				</div>
			{/if}
		{:else if tab !== 'chapter'}
			<p class="small muted">
				{tab === 'suggest'
					? 'Looks at your due cards, weak areas, open mistakes and test date, and suggests what to do today. One tap turns it into a session.'
					: tab === 'recap'
						? 'A short, friendly summary of your last week compared with the one before.'
						: 'Looks for repeating reasons and topics in your mistake journal and suggests a fix for each.'}
			</p>
		{:else if !shown('chapter')}
			<p class="small muted">Pick a chapter and get the key ideas with links back to the pages. Save it to your notes if it helps.</p>
		{/if}

		{#if tab !== 'chapter'}
			<div>
				<button type="button" class="btn btn-navy btn-sm" disabled={busy === tab} onclick={() => run(tab)}>
					{busy === tab ? 'Thinking…' : shown(tab) ? 'Do it again' : BUTTON[tab]}
				</button>
			</div>
		{/if}
	</div>
</section>

<style>
	.coach-body {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		margin-top: 1rem;
	}
	.sugg {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		counter-reset: sugg;
	}
	.sugg li {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		counter-increment: sugg;
	}
	.sugg li::before {
		content: counter(sugg);
		flex: none;
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent-text);
		font-size: 0.75rem;
		font-weight: 700;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.two {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(13rem, 1fr));
		gap: 0.75rem;
	}
	.two ul {
		margin: 0.25rem 0 0;
		padding-left: 1.125rem;
	}
	.pattern {
		border-left: 3px solid var(--accent-border);
		padding-left: 0.75rem;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
</style>
