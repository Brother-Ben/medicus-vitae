<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import CardsTabs from '#lib/components/CardsTabs.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Modal from '#lib/components/Modal.svelte';
	import { api } from '#lib/client/api.js';
	import { toast, toastAction, toastError } from '#lib/client/toast.svelte.js';
	import { bookmarkletFor } from '#lib/cars-bookmarklet.js';
	import { shortDate } from '#lib/dates.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const refresh = () => invalidate('app:cars');
	const pct = (c: number, t: number) => (t ? Math.round((c / t) * 100) : 0);
	const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
	const SOURCE: Record<string, string> = { jackwestin: 'Jack Westin', aamc: 'AAMC', other: 'Pasted' };
	const SKILL: Record<string, string> = { FC: 'Foundations of comprehension', RWT: 'Reasoning within the text', RBT: 'Reasoning beyond the text' };

	let bookmark = $state('');
	let origin = $state('');
	onMount(() => {
		origin = location.origin;
		bookmark = bookmarkletFor(location.origin);
		if (location.hash === '#paste') pasteOpen = true;
		// A passage brought in by the extension (in another tab) shows up here.
		let ch: BroadcastChannel | null = null;
		try {
			ch = new BroadcastChannel('medicus-cars');
			ch.onmessage = () => void refresh();
		} catch {
			ch = null;
		}
		return () => ch?.close();
	});

	// "Get today's passage": opens Jack Westin with this Medicus's address in the
	// #fragment; the browser extension then brings the newest passage not imported yet.
	const imported = $derived(
		data.passages
			.map((p) => /\/cars-practice-passages\/([^/?#]+)/.exec(p.sourceUrl ?? '')?.[1])
			.filter((s): s is string => !!s)
			.slice(0, 40)
	);
	const getHref = $derived(origin ? `${data.today.dailyUrl}#medicus=${encodeURIComponent(origin)}${imported.length ? `&skip=${imported.join(',')}` : ''}` : data.today.dailyUrl);

	function copyPath() {
		if (!data.extensionDir) return;
		void navigator.clipboard?.writeText(data.extensionDir).then(
			() => toast('Folder path copied'),
			() => toast('Couldn’t copy; select the path and copy it.', 'error')
		);
	}

	let setupOpen = $state(false);
	let pasteOpen = $state(false);
	let pasteText = $state('');
	let pasteTitle = $state('');
	let pasteSource = $state<'other' | 'aamc'>('other');
	let pasting = $state(false);
	let filter = $state<'all' | 'todo' | 'done'>('all');

	const shown = $derived(data.passages.filter((p) => (filter === 'todo' ? !p.attempts : filter === 'done' ? p.attempts > 0 : true)));
	const left = $derived(Math.max(0, data.today.perDay - data.today.importedToday));
	const maxTrend = $derived(Math.max(1, ...data.stats.trend.map((t) => t.scored)));

	async function savePrefs(patch: Record<string, unknown>) {
		try {
			await api('/api/cars', { body: { action: 'prefs', prefs: patch } });
			await refresh();
		} catch (err) {
			toastError(err);
		}
	}

	async function paste() {
		pasting = true;
		try {
			const r = await api<{ id: string; title: string; questions: number }>('/api/cars', { body: { action: 'paste', text: pasteText, title: pasteTitle, source: pasteSource } });
			pasteOpen = false;
			pasteText = '';
			pasteTitle = '';
			await refresh();
			toast(`Added “${r.title}” · ${r.questions} questions`);
		} catch (err) {
			toastError(err);
		} finally {
			pasting = false;
		}
	}

	async function remove(id: string, title: string) {
		try {
			await api('/api/cars', { body: { action: 'delete', passageId: id } });
			await refresh();
			toastAction(`Deleted “${title}”`, {
				label: 'Undo',
				run: async () => {
					await api('/api/cars', { body: { action: 'restore', passageId: id } });
					await refresh();
				}
			});
		} catch (err) {
			toastError(err);
		}
	}

	function copyBookmark() {
		void navigator.clipboard?.writeText(bookmark).then(
			() => toast('Copied. Make a new bookmark and paste this as its address (URL).'),
			() => toast('Couldn’t copy; drag the button to your bookmarks bar instead.', 'error')
		);
	}
</script>

<svelte:head><title>CARS · Flashcards · Medicus Vitae</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div>
			<h1>Flashcards</h1>
			<div class="subtitle">CARS passages: Jack Westin’s daily passage, AAMC or your own, timed and scored</div>
		</div>
		<div class="row-tight">
			<button type="button" class="btn" onclick={() => (pasteOpen = true)}><Icon name="clipboard" size={16} />Paste a passage</button>
			<a class="btn btn-primary" href={getHref} target="_blank" rel="noopener" title="Opens Jack Westin; the Medicus extension brings the newest passage in"><Icon name="download" size={16} />Get today’s passage</a>
		</div>
	</header>

	<CardsTabs carsWaiting={data.today.waiting} />

	<!-- Always here: open until the first import, then folded away, so the extension
	     can be set up again if Brave ever drops it. -->
	<details class="card card-flush setup" class:first={!data.today.bookmarkSet} open={!data.today.bookmarkSet}>
		<summary>
			<span class="setup-name">
				{#if data.today.bookmarkSet}
					Medicus extension <span class="muted setup-hint">· gone from Brave, or <strong>Get today’s passage</strong> does nothing? Set it up again</span>
				{:else}
					Set up one-click import (once)
				{/if}
			</span>
			<Icon name="chevron-down" size={16} class="chev" />
		</summary>
		<div class="setup-body">
			<div class="row" style="justify-content: space-between; align-items: flex-start">
				<p class="small muted" style="flex: 1 1 24rem">Add the Medicus extension to Brave. Then <strong>Get today’s passage</strong> brings the passage and all its questions in by itself.</p>
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => (setupOpen = true)}>How it works</button>
			</div>
			<ol class="steps small">
				<li>Open <span class="mono">brave://extensions</span> and turn on <strong>Developer mode</strong> (top right). If an older <strong>Medicus Vitae: Jack Westin import</strong> is still listed there, remove it first.</li>
				<li>
					Click <strong>Load unpacked</strong> and choose this folder (you can paste the path into the folder box):
					{#if data.extensionDir}
						<span class="row-tight" style="margin-top: 0.25rem"><code class="mono path">{data.extensionDir}</code><button type="button" class="btn btn-sm btn-ghost" onclick={copyPath}><Icon name="copy" size={14} />Copy</button></span>
					{:else}
						<span class="mono">browser-extension</span> in the Medicus folder.
					{/if}
				</li>
				<li>Press <strong>Get today’s passage</strong> above.</li>
			</ol>
			<p class="tiny muted">Brave loads the extension from that folder, so leave it where it is. Medicus keeps it up to date; after updating Medicus, press the reload arrow on the extension’s card in <span class="mono">brave://extensions</span>.</p>
		</div>
	</details>

	<div class="grid">
		<section class="card card-flush" aria-labelledby="today-h">
			<div class="card-head row" style="justify-content: space-between">
				<h2 id="today-h" class="section-label">Today</h2>
				{#if data.today.daily}<span class="tiny muted">{data.today.importedToday} of {data.today.perDay} imported</span>{/if}
			</div>
			<div class="list">
				{#if data.today.next}
					<div class="list-row">
						<div style="flex: 1 1 12rem; min-width: 0">
							<div class="list-title truncate">{data.today.next.title}</div>
							<div class="list-sub">{data.today.next.source} · {data.today.next.questions} questions · not done yet</div>
						</div>
						<a class="btn btn-sm btn-primary" href="/cards/cars/{data.today.next.id}"><Icon name="play" size={14} />Start</a>
					</div>
				{/if}
				{#if data.today.daily && left > 0}
					<div class="list-row">
						<div style="flex: 1 1 12rem; min-width: 0">
							<div class="list-title">{data.today.importedToday ? `${left} more passage${left === 1 ? '' : 's'} today` : 'Today’s Jack Westin passage'}</div>
							<div class="list-sub">Brought in by the Medicus extension (or your bookmark)</div>
						</div>
						<a class="btn btn-sm" href={getHref} target="_blank" rel="noopener"><Icon name="download" size={13} />Get</a>
					</div>
				{:else if data.today.daily}
					<div class="list-row"><span class="small muted"><Icon name="check" size={14} /> Today’s goal is imported.</span></div>
				{/if}
				{#if !data.today.daily && !data.today.next}
					<div class="list-row"><span class="small muted">Daily passages are off. Import one any time.</span></div>
				{/if}
			</div>
			<div class="prefs">
				<label class="checkbox small">
					<input type="checkbox" class="switch" checked={data.prefs.daily} onchange={(e) => savePrefs({ daily: (e.currentTarget as HTMLInputElement).checked })} />
					Daily passage
				</label>
				<label class="row-tight small" class:muted={!data.prefs.daily}>
					<select class="select input-sm" style="width: 4rem" value={data.prefs.perDay} disabled={!data.prefs.daily} onchange={(e) => savePrefs({ perDay: Number((e.currentTarget as HTMLSelectElement).value) })}>
						{#each [1, 2, 3, 4, 5] as n (n)}<option value={n}>{n}</option>{/each}
					</select>
					per day
				</label>
				<label class="row-tight small">
					<select class="select input-sm" style="width: auto" value={data.prefs.layout} onchange={(e) => savePrefs({ layout: (e.currentTarget as HTMLSelectElement).value })}>
						<option value="one">One question at a time</option>
						<option value="all">All questions at once</option>
					</select>
				</label>
			</div>
		</section>

		<section class="card" aria-labelledby="stats-h">
			<h2 id="stats-h" class="section-label">Your CARS numbers</h2>
			{#if data.stats.attempts}
				<div class="nums">
					<div><div class="stat-label">Correct</div><div class="stat-value">{pct(data.stats.correct, data.stats.scored)}%</div><div class="stat-sub">{data.stats.correct} of {data.stats.scored}</div></div>
					<div><div class="stat-label">Per passage</div><div class="stat-value">{clock(data.stats.avgSeconds)}</div><div class="stat-sub">{data.stats.attempts} done</div></div>
					<div><div class="stat-label">Per question</div><div class="stat-value">{clock(data.stats.avgQuestionSeconds)}</div><div class="stat-sub">average</div></div>
					<div><div class="stat-label">Last 7 days</div><div class="stat-value">{data.stats.week.passages}</div><div class="stat-sub">{pct(data.stats.week.correct, data.stats.week.total)}% correct</div></div>
				</div>
				{#if data.stats.trend.length > 1}
					<div class="trend" role="img" aria-label="Accuracy by week: {data.stats.trend.map((t) => `${shortDate(t.week)} ${pct(t.correct, t.scored)}%`).join(', ')}">
						{#each data.stats.trend as t (t.week)}
							<div class="t-col" title="Week of {shortDate(t.week)}: {pct(t.correct, t.scored)}% of {t.scored} ({t.passages} passages)">
								<span class="tiny mono">{pct(t.correct, t.scored)}%</span>
								<div class="t-bar" style="height: {Math.max(4, Math.round((pct(t.correct, t.scored) / 100) * 64))}px; opacity: {0.45 + 0.55 * (t.scored / maxTrend)}"></div>
								<span class="tiny muted">{shortDate(t.week)}</span>
							</div>
						{/each}
					</div>
				{/if}
				{#if data.stats.bySkill.length}
					<div class="stack-sm" style="margin-top: 0.75rem">
						{#each data.stats.bySkill as s (s.skill)}
							<div class="row small" style="justify-content: space-between"><span>{SKILL[s.skill] ?? s.skill}</span><span class="mono">{pct(s.correct, s.scored)}% · {s.scored}</span></div>
							<div class="bar"><span style="width: {pct(s.correct, s.scored)}%"></span></div>
						{/each}
					</div>
				{/if}
			{:else}
				<p class="small muted" style="margin-top: 0.5rem">Do a passage and your accuracy and timing show here: per passage, per question, and week by week.</p>
			{/if}
		</section>
	</div>

	<section class="card card-flush" aria-labelledby="list-h">
		<div class="card-head row" style="justify-content: space-between">
			<h2 id="list-h" class="section-label">Passages · {data.passages.length}</h2>
			<div class="segmented" role="tablist" aria-label="Show">
				<button type="button" role="tab" aria-selected={filter === 'all'} onclick={() => (filter = 'all')}>All</button>
				<button type="button" role="tab" aria-selected={filter === 'todo'} onclick={() => (filter = 'todo')}>Not done</button>
				<button type="button" role="tab" aria-selected={filter === 'done'} onclick={() => (filter = 'done')}>Done</button>
			</div>
		</div>
		{#if shown.length}
			<div class="list">
				{#each shown as p (p.id)}
					<div class="list-row">
						<a class="p-main" href="/cards/cars/{p.id}">
							<span class="list-title truncate">{p.title}</span>
							<span class="list-sub">
								{SOURCE[p.source] ?? p.source}{p.topic ? ` · ${p.topic}` : ''} · {p.questions} q · {p.wordCount} words · {p.publishedOn ? shortDate(p.publishedOn) : `added ${shortDate(p.importedDay)}`}{p.answerKey ? '' : ' · no answer key'}
							</span>
						</a>
						{#if p.last}
							<span class="score mono" class:good={p.last.scored && p.last.correct / p.last.scored >= 0.7} title="Last try: {p.last.correct} of {p.last.scored} in {clock(p.last.seconds)}">
								{p.last.scored ? `${p.last.correct}/${p.last.scored}` : '—'} · {clock(p.last.seconds)}
							</span>
						{:else}
							<span class="pill pill-sm pill-accent">New</span>
						{/if}
						<div class="row-tight">
							<a class="btn btn-sm btn-ghost" href="/cards/cars/{p.id}">{p.attempts ? 'Review' : 'Start'}</a>
							<button type="button" class="icon-btn plain sm" aria-label="Delete {p.title}" title="Delete" onclick={() => remove(p.id, p.title)}><Icon name="trash" size={15} /></button>
						</div>
					</div>
				{/each}
			</div>
		{:else}
			<div class="empty">
				<Icon name="book" size={26} />
				<h2>{data.passages.length ? 'Nothing here' : 'No passages yet'}</h2>
				<p>Press <strong>Get today’s passage</strong>, or paste a passage from anywhere (AAMC CARS packs too).</p>
			</div>
		{/if}
	</section>
</div>

<Modal bind:open={setupOpen} title="One-click import">
	<div class="stack-sm small">
		<p><strong>Why an extension?</strong> Jack Westin’s site turns away apps (it shows a “Just a moment…” check to anything that isn’t a person’s browser), so Medicus can’t fetch passages on its own. Your own browser can, and the extension does the clicking for you.</p>
		<ol class="steps">
			<li><strong>Get today’s passage</strong> opens Jack Westin in a new tab, with this Medicus’s address attached.</li>
			<li>The extension opens the newest passage you haven’t imported and waits for it to load.</li>
			<li>It reads the passage, every question, the answer key and the explanations from the data the page itself holds, so nothing is clicked or submitted there. Then the tab switches to Medicus with the passage imported.</li>
			<li>On any passage page, the extension’s <strong>Send to Medicus</strong> button (bottom right) does the same.</li>
		</ol>
		<p class="muted">It runs only on jackwestin.com, sends the page only to your Medicus, and needs no other permissions.</p>
		{#if data.extensionDir}<p class="small">Extension folder: <code class="mono path">{data.extensionDir}</code></p>{/if}
		<p><strong>No extension?</strong> The bookmark does the same for the page you press it on: drag it to your bookmarks bar (Ctrl+Shift+B shows the bar).</p>
		<div class="row" style="margin-top: 0.25rem">
			<a class="btn btn-navy bookmarklet" href={bookmark} onclick={(e) => e.preventDefault()} draggable="true"><Icon name="bookmark" size={16} />Send to Medicus</a>
			<button type="button" class="btn btn-sm" onclick={copyBookmark}><Icon name="copy" size={14} />Copy instead</button>
		</div>
	</div>
	{#snippet footer()}
		<button type="button" class="btn btn-primary" onclick={() => (setupOpen = false)}>Done</button>
	{/snippet}
</Modal>

<Modal bind:open={pasteOpen} title="Paste a passage" wide>
	<div class="stack-sm">
		<p class="small muted">Copy the whole page (passage and questions, with answers and explanations if shown) and paste it here. Works for AAMC CARS packs too.{data.ai ? '' : ' Connect an AI service in Settings › AI to read pages that aren’t laid out as numbered questions.'}</p>
		<div class="form-grid">
			<label class="field"><span class="label">Title <span class="muted">(optional)</span></span><input class="input" bind:value={pasteTitle} /></label>
			<label class="field">
				<span class="label">From</span>
				<select class="select" bind:value={pasteSource}><option value="other">Somewhere else</option><option value="aamc">AAMC</option></select>
			</label>
		</div>
		<label class="field"><span class="label">Page text</span><textarea class="textarea" rows="14" bind:value={pasteText} placeholder="Passage…&#10;&#10;1. Question…&#10;A. …&#10;B. …"></textarea></label>
	</div>
	{#snippet footer()}
		<button type="button" class="btn" onclick={() => (pasteOpen = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" disabled={pasting || pasteText.trim().length < 400} onclick={paste}>{pasting ? 'Reading…' : 'Add passage'}</button>
	{/snippet}
</Modal>

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
		gap: 1rem;
		align-items: start;
	}
	.setup.first {
		border-color: var(--accent-border);
	}
	.setup > summary {
		list-style: none;
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.75rem 1rem;
		cursor: pointer;
	}
	.setup > summary::-webkit-details-marker {
		display: none;
	}
	.setup > summary:hover {
		background: var(--hover);
	}
	.setup-name {
		flex: 1 1 auto;
		min-width: 0;
		font-weight: 600;
	}
	.setup.first .setup-name {
		font-size: 1.0625rem;
	}
	.setup-hint {
		font-weight: 400;
	}
	.setup > summary :global(.chev) {
		flex: none;
		color: var(--text-3);
		transition: transform 0.15s;
	}
	.setup[open] > summary :global(.chev) {
		transform: rotate(180deg);
	}
	.setup-body {
		padding: 0.25rem 1rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.bookmarklet {
		cursor: grab;
	}
	code.path {
		font-size: 0.75rem;
		background: var(--surface-2);
		border-radius: 4px;
		padding: 0.125rem 0.375rem;
		overflow-wrap: anywhere;
	}
	.prefs {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem 1rem;
		padding: 0.5rem 1rem;
		border-top: 1px solid var(--border);
	}
	.prefs .checkbox {
		min-height: 2rem;
	}
	.nums {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.75rem;
		margin-top: 0.625rem;
	}
	@media (max-width: 560px) {
		.nums {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
	.trend {
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
		margin-top: 1rem;
	}
	.t-col {
		flex: 1 1 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 3px;
	}
	.t-bar {
		width: 100%;
		max-width: 28px;
		background: var(--sec-cars);
		border-radius: 3px 3px 0 0;
	}
	:global(:root[data-section-colors='off']) .t-bar {
		background: var(--accent);
	}
	.p-main {
		flex: 1 1 14rem;
		min-width: 0;
		display: flex;
		flex-direction: column;
		color: inherit;
		text-decoration: none;
	}
	.p-main:hover .list-title {
		text-decoration: underline;
	}
	.score {
		font-size: 0.75rem;
		color: var(--text-2);
		white-space: nowrap;
	}
	.score.good {
		color: var(--accent-text);
	}
	.steps {
		margin: 0;
		padding-left: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
</style>
