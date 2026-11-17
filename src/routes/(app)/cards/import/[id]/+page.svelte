<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { onMount } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { api } from '#lib/client/api.js';
	import { toastError } from '#lib/client/toast.svelte.js';
	import { htmlToText } from '#lib/cards.js';
	import type { ImportAnalysis, ImportResult } from '#lib/server/anki/importer.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Kept current by polling while the server works on it.
	let imp = $derived(data.imp);
	const analysis = $derived(imp.analysis as ImportAnalysis | null);
	const result = $derived(imp.result as ImportResult | null);
	const working = $derived(imp.status === 'analyzing' || imp.status === 'importing');

	let choices = $state<Record<string, 'keep' | 'overwrite'>>({});
	let conflictDefault = $state<'keep' | 'overwrite'>('keep');
	let useDeckRetention = $state(false);
	let busy = $state(false);
	let openConflict = $state<string | null>(null);

	const fmt = (n: number) => n.toLocaleString('en-US');
	const pct = (r: number | null) => (r === null ? '' : `${Math.round(r * 100)}%`);

	onMount(() => {
		const t = setInterval(async () => {
			if (!working) return;
			try {
				const r = await api<{ import: typeof data.imp }>(`/api/anki/${imp.id}`);
				if (r.import.status === imp.status || (r.import.status !== 'ready' && r.import.status !== 'done' && r.import.status !== 'failed')) {
					imp = r.import;
				} else {
					// Finished a step: reload everything (this page's data and the sidebar counts) so nothing shows stale state.
					await invalidateAll();
				}
			} catch {
				// keep polling; the server may be busy
			}
		}, 1000);
		return () => clearInterval(t);
	});

	function choose(guid: string, c: 'keep' | 'overwrite') {
		choices[guid] = c;
	}

	function setAll(c: 'keep' | 'overwrite') {
		conflictDefault = c;
		choices = {};
	}

	async function confirm() {
		busy = true;
		try {
			await api(`/api/anki/${imp.id}`, { body: { action: 'confirm', decisions: { conflicts: choices, conflictDefault, useDeckRetention } } });
			imp = { ...imp, status: 'importing', progress: 0, message: 'Starting' };
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	async function cancel() {
		busy = true;
		try {
			await api(`/api/anki/${imp.id}`, { body: { action: 'cancel' } });
			await goto('/cards/import');
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	const preview = (html: string) => htmlToText(html).replace(/\s+/g, ' ').trim() || '(empty)';
	const choiceFor = (guid: string) => choices[guid] ?? conflictDefault;
</script>

<svelte:head><title>Anki import · Medicus Vitae</title></svelte:head>

<div class="page narrow">
	<header class="page-header">
		<div style="min-width: 0">
			<a class="small muted back" href="/cards/import"><Icon name="arrow-left" size={14} />Import from Anki</a>
			<h1 class="truncate">{imp.fileName}</h1>
			<p class="subtitle">
				{#if analysis}Anki package · {analysis.version === 'latest' ? 'current format' : 'older format'} · {fmt(analysis.totals.notes)} notes, {fmt(analysis.totals.cards)} cards{/if}
			</p>
		</div>
	</header>

	{#if working}
		<div class="card">
			<div class="row" style="justify-content: space-between">
				<strong>{imp.status === 'analyzing' ? 'Reading the package' : 'Importing'}</strong>
				<span class="small muted">{Math.round(imp.progress * 100)}%</span>
			</div>
			<div class="bar" style="margin-top: 0.5rem"><span style="width: {Math.round(imp.progress * 100)}%"></span></div>
			<p class="small muted" style="margin-top: 0.5rem">{imp.message || 'Working…'} You can leave this page; it keeps going.</p>
		</div>
	{:else if imp.status === 'failed'}
		<div class="error-box" role="alert"><Icon name="alert" size={18} /><div>{imp.error ?? 'The import failed.'}</div></div>
		<a class="btn" href="/cards/import" style="align-self: flex-start">Try another file</a>
	{:else if imp.status === 'cancelled'}
		<div class="notice"><Icon name="info" size={18} />This import was cancelled; nothing was added.</div>
	{/if}

	{#if imp.status === 'done' && result}
		<section class="card stack">
			<h2 style="font-size: 1.125rem">Imported</h2>
			<div class="tiles">
				<div><div class="tiny muted">New notes</div><div class="mono stat">{fmt(result.notesAdded)}</div></div>
				<div><div class="tiny muted">Updated</div><div class="mono stat">{fmt(result.notesUpdated + result.conflictsOverwritten)}</div></div>
				<div><div class="tiny muted">New cards</div><div class="mono stat">{fmt(result.cardsAdded)}</div></div>
				<div><div class="tiny muted">Reviews carried over</div><div class="mono stat">{fmt(result.reviewsImported)}</div></div>
				<div><div class="tiny muted">Images &amp; sounds</div><div class="mono stat">{fmt(result.mediaAdded)}</div></div>
			</div>
			{#if result.conflictsKept}<p class="small">Kept your version of {result.conflictsKept} note{result.conflictsKept === 1 ? '' : 's'} you had edited.</p>{/if}
			{#if result.reviewsAlreadyHere}<p class="small muted">{fmt(result.reviewsAlreadyHere)} reviews were already here from an earlier import and weren’t counted twice.</p>{/if}
			{#if result.mediaRenamed}<p class="small muted">{result.mediaRenamed} media file{result.mediaRenamed === 1 ? '' : 's'} had the same name as a different file already here, so they were renamed and their notes updated.</p>{/if}
			{#if result.retentionChangedTo}<p class="small">Desired retention is now {pct(result.retentionChangedTo)}, from the deck’s preset.</p>{/if}
			<div class="row">
				<a class="btn btn-primary" href="/review"><Icon name="play" size={18} />Study now</a>
				<a class="btn" href="/cards?state=leech">Leeches</a>
				<a class="btn" href="/cards">See all cards</a>
			</div>
		</section>
	{/if}

	{#if analysis && (imp.status === 'ready' || imp.status === 'done')}
		<!-- Older saved reports listed card scripts as unsupported; they aren't (they run inside each card). -->
		{@const issues = analysis.unsupported.filter((u) => u.kind !== 'script')}
		{#if imp.status === 'ready'}
			<section class="card stack">
				<h2 style="font-size: 1.125rem">What will happen</h2>
				<div class="tiles">
					<div><div class="tiny muted">New notes</div><div class="mono stat">{fmt(analysis.plan.newNotes)}</div></div>
					<div><div class="tiny muted">Updated from the deck</div><div class="mono stat">{fmt(analysis.plan.updatedNotes)}</div></div>
					<div><div class="tiny muted">Unchanged</div><div class="mono stat">{fmt(analysis.plan.unchangedNotes + analysis.plan.keptLocal)}</div></div>
					<div><div class="tiny muted">New cards</div><div class="mono stat">{fmt(analysis.plan.newCards)}</div></div>
					<div><div class="tiny muted">Images &amp; sounds</div><div class="mono stat">{fmt(analysis.media.files)}</div></div>
				</div>
				{#if analysis.plan.keptLocal}<p class="small muted">{analysis.plan.keptLocal} note{analysis.plan.keptLocal === 1 ? '' : 's'} you edited here didn’t change in the deck, so they stay as you left them.</p>{/if}
			</section>
		{/if}

		<section class="card stack">
			<h2 style="font-size: 1.125rem">Review history</h2>
			<div class={analysis.history.status === 'included' ? 'notice' : 'warning'}>
				<Icon name={analysis.history.status === 'included' ? 'check' : 'info'} size={18} />
				<div>{analysis.history.message}</div>
			</div>
			{#if analysis.history.notReviews}
				<p class="small muted">
					{analysis.history.notReviews === 1 ? 'One entry' : `${fmt(analysis.history.notReviews)} entries`} in Anki’s log {analysis.history.notReviews === 1 ? 'was a manual reschedule' : 'were manual reschedules'} (like “set due date”), not {analysis.history.notReviews === 1 ? 'an answer' : 'answers'}, so {analysis.history.notReviews === 1 ? 'it isn’t' : 'they aren’t'} counted as reviews.
				</p>
			{/if}
		</section>

		{#if analysis.tags}
			<section class="card stack">
				<h2 style="font-size: 1.125rem">Tags</h2>
				{#if analysis.tags.tagged}
					<div class="notice">
						<Icon name="check" size={18} />
						<div>
							{fmt(analysis.tags.tagged)} of {fmt(analysis.totals.notes)} notes come with their tags ({fmt(analysis.tags.distinct)} different tags). Link the deck to a book and its chapters are matched to these tags, so finishing a chapter unsuspends its cards.
						</div>
					</div>
					<ul class="samples mono">
						{#each analysis.tags.groups as g (g.name)}<li>{g.name} <span class="muted">· {fmt(g.notes)} note{g.notes === 1 ? '' : 's'}</span></li>{/each}
					</ul>
				{:else}
					<div class="warning"><Icon name="info" size={18} /><div>None of these notes have tags. Chapters can still be matched to subdecks.</div></div>
				{/if}
				{#if analysis.scriptNotes}
					<p class="small muted">{fmt(analysis.scriptNotes)} note{analysis.scriptNotes === 1 ? ' uses' : 's use'} the deck’s own card scripts (hint buttons, tag lists and the like). They run as they do in Anki, inside each card.</p>
				{/if}
			</section>
		{/if}

		{#if issues.length}
			<section class="card stack">
				<h2 style="font-size: 1.125rem">Not supported, or changed on the way in</h2>
				{#each issues as u (u.kind)}
					<details class="issue">
						<summary>
							<span class="strong">{u.title}</span>
							{#if u.kind !== 'deck_options' && u.kind !== 'media_missing'}<span class="pill pill-warn pill-sm">{fmt(u.count)} note{u.count === 1 ? '' : 's'}</span>{/if}
							{#if u.kind === 'media_missing'}<span class="pill pill-warn pill-sm">{fmt(u.count)} file{u.count === 1 ? '' : 's'}</span>{/if}
						</summary>
						<p class="small" style="margin: 0.5rem 0">{u.detail}</p>
						{#if u.notes.length}
							<ul class="samples">
								{#each u.notes as s (s.guid)}<li>{s.preview}</li>{/each}
								{#if u.count > u.notes.length}<li class="muted">…and {fmt(u.count - u.notes.length)} more</li>{/if}
							</ul>
						{/if}
						{#if u.kind === 'media_missing'}
							<ul class="samples mono">
								{#each analysis.media.missing as f (f.name)}<li>{f.name} <span class="muted">({f.notes} note{f.notes === 1 ? '' : 's'})</span></li>{/each}
							</ul>
						{/if}
					</details>
				{/each}
			</section>
		{/if}

		{#if imp.status === 'ready' && analysis.plan.conflicts}
			<section class="card stack">
				<h2 style="font-size: 1.125rem">Cards you edited here that the deck also changed</h2>
				<p class="small">
					{analysis.plan.conflicts} note{analysis.plan.conflicts === 1 ? '' : 's'} changed in both places. Choose which version to keep. Keeping yours means this deck version won’t be asked about again.
				</p>
				<div class="row-tight" role="group" aria-label="Choice for all">
					<button type="button" class="btn btn-sm" aria-pressed={conflictDefault === 'keep' && !Object.keys(choices).length} onclick={() => setAll('keep')}>Keep mine for all</button>
					<button type="button" class="btn btn-sm" aria-pressed={conflictDefault === 'overwrite' && !Object.keys(choices).length} onclick={() => setAll('overwrite')}>Use the deck’s for all</button>
				</div>
				<ul class="conflicts">
					{#each analysis.conflicts as c (c.guid)}
						<li>
							<div class="row" style="justify-content: space-between; gap: 0.75rem">
								<button type="button" class="linkish truncate" onclick={() => (openConflict = openConflict === c.guid ? null : c.guid)}>
									{preview(Object.values(c.local)[0] ?? '')}
								</button>
								<div class="segmented" role="radiogroup" aria-label="Version to keep">
									<button type="button" role="radio" aria-checked={choiceFor(c.guid) === 'keep'} onclick={() => choose(c.guid, 'keep')}>Mine</button>
									<button type="button" role="radio" aria-checked={choiceFor(c.guid) === 'overwrite'} onclick={() => choose(c.guid, 'overwrite')}>Deck’s</button>
								</div>
							</div>
							{#if openConflict === c.guid}
								<div class="compare">
									{#each c.fieldNames as f (f)}
										{#if (c.local[f] ?? '') !== (c.incoming[f] ?? '')}
											<div class="tiny muted strong">{f}</div>
											<div class="side"><span class="tiny muted">Yours</span>{preview(c.local[f] ?? '')}</div>
											<div class="side"><span class="tiny muted">Deck</span>{preview(c.incoming[f] ?? '')}</div>
										{/if}
									{/each}
									{#if c.localTags.join(' ') !== c.incomingTags.join(' ')}
										<div class="tiny muted strong">Tags</div>
										<div class="side"><span class="tiny muted">Yours</span>{c.localTags.join(' ') || '—'}</div>
										<div class="side"><span class="tiny muted">Deck</span>{c.incomingTags.join(' ') || '—'}</div>
									{/if}
								</div>
							{/if}
						</li>
					{/each}
				</ul>
				{#if analysis.plan.conflicts > analysis.conflicts.length}
					<p class="small muted">Showing {analysis.conflicts.length}; the rest follow the “for all” choice.</p>
				{/if}
			</section>
		{/if}

		{#if imp.status === 'ready' && analysis.retention.deck && Math.abs(analysis.retention.deck - analysis.retention.current) >= 0.005}
			<section class="card stack">
				<h2 style="font-size: 1.125rem">Desired retention</h2>
				<label class="checkbox">
					<input type="checkbox" bind:checked={useDeckRetention} />
					<span>Use the deck’s {pct(analysis.retention.deck)} instead of your current {pct(analysis.retention.current)} (applies to all your cards)</span>
				</label>
			</section>
		{/if}

		<details class="card more">
			<summary class="strong">Note types and decks</summary>
			<div class="two-col">
				<div>
					<div class="tiny muted strong" style="margin: 0.75rem 0 0.25rem">Note types</div>
					<ul class="samples">
						{#each analysis.noteTypes as t (t.name)}
							<li>{t.name} <span class="muted">· {t.kind === 'cloze' ? 'cloze' : `${t.fields.length} fields`} · {fmt(t.notes)} notes{t.scripts ? ' · has scripts' : ''}{t.imageOcclusion ? ' · image occlusion' : ''}</span></li>
						{/each}
					</ul>
				</div>
				<div>
					<div class="tiny muted strong" style="margin: 0.75rem 0 0.25rem">Decks</div>
					<ul class="samples">
						{#each analysis.decks as d (d.name)}<li>{d.name} <span class="muted">· {fmt(d.cards)} cards{d.preset ? ` · preset “${d.preset}”` : ''}</span></li>{/each}
					</ul>
				</div>
			</div>
		</details>

		{#if imp.status === 'ready'}
			<div class="row">
				<button type="button" class="btn btn-primary btn-lg" disabled={busy} onclick={confirm}>
					Import {fmt(analysis.plan.newNotes + analysis.plan.updatedNotes)} note{analysis.plan.newNotes + analysis.plan.updatedNotes === 1 ? '' : 's'}{analysis.plan.conflicts ? ' and apply your choices' : ''}
				</button>
				<button type="button" class="btn" disabled={busy} onclick={cancel}>Cancel</button>
			</div>
		{/if}
	{/if}
</div>

<style>
	.narrow {
		max-width: 56rem;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		margin-bottom: 0.25rem;
		color: var(--text-3);
		text-decoration: none;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(8.5rem, 1fr));
		gap: 0.875rem;
	}
	.stat {
		font-size: 1.5rem;
		font-weight: 600;
	}
	.issue {
		border-top: 1px solid var(--border);
		padding-top: 0.625rem;
	}
	.issue summary {
		cursor: pointer;
		display: flex;
		gap: 0.5rem;
		align-items: center;
		flex-wrap: wrap;
	}
	.samples {
		margin: 0.25rem 0 0;
		padding-left: 1.125rem;
		font-size: 0.875rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		max-height: 16rem;
		overflow-y: auto;
	}
	.conflicts {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
	}
	.conflicts li {
		border-top: 1px solid var(--border);
		padding: 0.625rem 0;
	}
	.linkish {
		background: none;
		border: 0;
		padding: 0;
		color: var(--accent-text);
		cursor: pointer;
		text-align: left;
		font: inherit;
		min-width: 0;
		flex: 1;
	}
	.compare {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 0.375rem 0.75rem;
		margin-top: 0.625rem;
		font-size: 0.875rem;
	}
	.compare .tiny.strong {
		grid-column: 1 / -1;
		margin-top: 0.25rem;
	}
	.side {
		background: var(--surface-2);
		border-radius: var(--radius-sm);
		padding: 0.5rem 0.625rem;
		display: flex;
		flex-direction: column;
		gap: 0.125rem;
	}
	.more summary {
		cursor: pointer;
	}
	.two-col {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr));
		gap: 1rem;
	}
	.btn[aria-pressed='true'] {
		background: var(--ink);
		border-color: var(--ink);
		color: var(--on-ink);
	}
	@media (max-width: 600px) {
		.compare {
			grid-template-columns: 1fr;
		}
	}
</style>
