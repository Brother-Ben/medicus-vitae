<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import CategorySelect from '#lib/components/CategorySelect.svelte';
	import DeckLinkDialog from '#lib/components/DeckLinkDialog.svelte';
	import DeleteBookDialog from '#lib/components/DeleteBookDialog.svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Modal from '#lib/components/Modal.svelte';
	import { api } from '#lib/client/api.js';
	import { floatMenu } from '#lib/client/float-menu.js';
	import { markSections, progressToast, type ProgressResult } from '#lib/client/progress.js';
	import { toast, toastAction, toastError } from '#lib/client/toast.svelte.js';
	import { CATEGORY_SHORT } from '#lib/aamc.js';
	import { chapterKey, isCovered, leafSections, mergeRanges } from '#lib/ranges.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let title = $derived(data.book.title);
	let renaming = $state(false);
	let adding = $state<Record<string, string | null>>({});
	let editingCodes = $state<string | null>(null);
	let tab = $state<'chapters' | 'decks'>('chapters');
	let menuOpen = $state(false);
	let deleteOpen = $state(false);

	onMount(() => {
		if (location.hash === '#decks') tab = 'decks';
	});

	const ranges = $derived(mergeRanges(data.book.readRanges, data.book.pageCount));
	const leaves = $derived(new Set(leafSections(data.sections).map((s) => s.id)));
	const isDone = (s: { pageStart: number; pageEnd: number }) => isCovered(ranges, s.pageStart, s.pageEnd);
	const unconfirmed = $derived(data.sections.filter((s) => !s.confirmed && s.suggestedCodes.length).length);

	// Flat lists of numbered sections ("5.1", "5.2" …) are grouped by chapter.
	const groups = $derived.by(() => {
		const keyed = data.sections.map((s) => ({ s, key: s.level === 0 ? chapterKey(s.title) : null }));
		const numbered = keyed.filter((k) => k.key).length;
		const distinct = new Set(keyed.map((k) => k.key).filter(Boolean)).size;
		if (numbered < data.sections.length * 0.6 || distinct < 2 || distinct === data.sections.length) return [{ key: null as string | null, sections: data.sections }];
		const out: { key: string | null; sections: typeof data.sections }[] = [];
		for (const k of keyed) {
			const last = out[out.length - 1];
			if (last && last.key === k.key) last.sections.push(k.s);
			else out.push({ key: k.key, sections: [k.s] });
		}
		return out;
	});

	async function post(body: Record<string, unknown>, message?: string) {
		try {
			await api(`/api/library/${data.book.id}`, { body });
			if (message) toast(message);
			await invalidate('app:book');
		} catch (err) {
			toastError(err);
		}
	}

	async function setCodes(sectionId: string, codes: string[]) {
		await post({ action: 'section-codes', sectionId, codes });
	}

	const refresh = () => invalidate('app:book');

	async function toggle(ids: string[], done: boolean, label: string) {
		await markSections(data.book.id, ids, done, label, refresh);
	}

	// "I've read up to page N" and reset.
	let upToOpen = $state(false);
	let upTo = $state(1);
	let resetOpen = $state(false);
	async function saveUpTo(page: number) {
		try {
			const r = await api<ProgressResult>(`/api/library/${data.book.id}`, { body: { action: 'read-up-to', page } });
			upToOpen = false;
			await refresh();
			progressToast(data.book.id, page ? `Progress set to page ${page}` : 'Progress reset', r, refresh);
		} catch (err) {
			toastError(err);
		}
	}

	// AI-02: generate cards, questions or notes from a chapter; they wait for approval.
	let genOpen = $state(false);
	let genSection = $state<(typeof data.sections)[number] | null>(null);
	let genKind = $state<'card' | 'question' | 'note'>('card');
	let genCount = $state(8);
	let gen = $state<{ status: string; items: number; flagged: number; error: string | null } | null>(null);

	function openGenerate(s: (typeof data.sections)[number]) {
		genSection = s;
		gen = null;
		genOpen = true;
	}

	async function startGenerate() {
		if (!genSection) return;
		try {
			const r = await api<{ batchId: string; jobId: string }>('/api/ai/generate', {
				body: { documentId: data.book.id, sectionId: genSection.id, kind: genKind, count: genCount }
			});
			gen = { status: 'queued', items: 0, flagged: 0, error: null };
			const poll = setInterval(async () => {
				try {
					const s = await api<{ status: string; items: number; flagged: number; error: string | null }>(`/api/ai/generate?job=${r.jobId}&batch=${r.batchId}`);
					gen = s;
					if (s.status === 'done' || s.status === 'failed') clearInterval(poll);
				} catch {
					clearInterval(poll);
				}
			}, 1500);
		} catch (err) {
			toastError(err);
		}
	}

	// Linked Anki decks.
	let linkOpen = $state(false);
	let editLink = $state<(typeof data.links)[number] | null>(null);
	let unlinking = $state<(typeof data.links)[number] | null>(null);
	let unlinkOpen = $state(false);
	let unlinkRestore = $state(true);

	async function unlink() {
		if (!unlinking) return;
		const r = await api<{ summary: { batchId: string; unsuspended: number } | null }>('/api/deck-links', { body: { action: 'delete', linkId: unlinking.id, restore: unlinkRestore } });
		await refresh();
		const n = r.summary?.unsuspended ?? 0;
		if (n && r.summary) {
			const batchId = r.summary.batchId;
			toastAction(`Unlinked · ${n} card${n === 1 ? '' : 's'} unsuspended`, {
				label: 'Undo unsuspend',
				run: async () => {
					await api('/api/deck-links', { body: { action: 'undo', batchId } });
					await refresh();
				}
			});
		} else toast('Unlinked');
	}

	const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
</script>

<svelte:window onclick={() => (menuOpen = false)} />

<svelte:head><title>{data.book.title} · Medicus Vitae</title></svelte:head>

<div class="page book-page">
	<a href="/library" class="back small"><Icon name="chevron-left" size={14} />Library</a>
	<header class="page-header">
		<div style="min-width: 0; flex: 1 1 20rem">
			{#if renaming}
				<form
					class="row"
					onsubmit={async (e) => {
						e.preventDefault();
						await post({ action: 'rename', title }, 'Renamed');
						renaming = false;
					}}
				>
					<label for="book-title" class="sr-only">Title</label>
					<!-- svelte-ignore a11y_autofocus -->
					<input id="book-title" class="input" style="font-size: 1.125rem; font-weight: 650; flex: 1 1 18rem" bind:value={title} autofocus />
					<button class="btn btn-primary">Save</button>
					<button type="button" class="btn btn-ghost" onclick={() => (renaming = false)}>Cancel</button>
				</form>
			{:else}
				<h1>{data.book.title}</h1>
				<div class="subtitle">
					{data.book.pageCount ?? '?'} pages · {plural(data.book.highlights, 'highlight')} · {plural(data.book.annotations, 'note')} · {plural(data.book.cards, 'card')}
				</div>
			{/if}
		</div>
		<div class="row-tight">
			{#if data.book.cards}<a class="btn" href="/cards?doc={data.book.id}"><Icon name="cards" size={16} />Cards</a>{/if}
			{#if data.book.status === 'ready'}<a class="btn btn-primary" href="/library/{data.book.id}/read?page={data.book.lastPage ?? 1}"><Icon name="book" size={16} />{data.book.lastPage ? 'Resume' : 'Read'}</a>{/if}
			<div class="menu-wrap">
				<button
					type="button"
					class="icon-btn"
					aria-label="More"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
					onclick={(e) => {
						e.stopPropagation();
						menuOpen = !menuOpen;
					}}><Icon name="more" size={18} /></button
				>
				{#if menuOpen}
					<div class="menu" role="menu" use:floatMenu>
						<button type="button" role="menuitem" onclick={() => (renaming = true)}><Icon name="edit" size={15} />Rename</button>
						{#if data.book.status === 'failed'}<button type="button" role="menuitem" onclick={() => post({ action: 'retry' }, 'Processing again')}><Icon name="refresh" size={15} />Process again</button>{/if}
						<hr />
						<button type="button" role="menuitem" class="danger" onclick={() => (deleteOpen = true)}><Icon name="trash" size={15} />Delete book…</button>
					</div>
				{/if}
			</div>
		</div>
	</header>

	{#if data.book.status === 'failed'}
		<div class="error-box"><Icon name="alert" size={16} />{data.book.error}</div>
		<div><button type="button" class="btn" onclick={() => post({ action: 'retry' }, 'Processing again')}><Icon name="refresh" size={16} />Try again</button></div>
	{/if}
	{#if data.book.notice}<div class="warning"><Icon name="info" size={16} />{data.book.notice}</div>{/if}

	<section class="card progress-card" aria-labelledby="prog-h">
		<div class="prog-top">
			<div>
				<h2 id="prog-h" class="section-label">Progress</h2>
				<div class="prog-num"><span class="mono">{data.book.done.pct}%</span> done</div>
				<div class="small muted">
					{data.book.done.sectionsTotal ? `${data.book.done.sectionsDone} of ${data.book.done.sectionsTotal} sections` : ''}{data.book.done.sectionsTotal ? ' · ' : ''}{data.book.done.pagesDone} of {data.book.pageCount ?? 0} pages
				</div>
			</div>
			<div class="row-tight">
				<button
					type="button"
					class="btn btn-sm"
					onclick={() => {
						upTo = Math.max(1, ranges.length && ranges[0][0] === 1 ? ranges[0][1] : data.book.lastPage ?? 1);
						upToOpen = true;
					}}>Set to a page…</button
				>
				{#if ranges.length}<button type="button" class="btn btn-sm btn-ghost" onclick={() => (resetOpen = true)}>Reset</button>{/if}
			</div>
		</div>
		<div class="bar bar-lg" style="margin-top: 0.75rem"><span style="width: {data.book.done.pct}%"></span></div>
		<p class="hint" style="margin-top: 0.5rem">Progress counts only what you mark done: check off chapters below or in the reader. Opening pages doesn’t change it.</p>
	</section>

	<div class="tabs" aria-label="Book sections" role="tablist">
		<button type="button" role="tab" aria-selected={tab === 'chapters'} onclick={() => (tab = 'chapters')}>Chapters <span class="count">{data.sections.length}</span></button>
		<button type="button" role="tab" aria-selected={tab === 'decks'} onclick={() => (tab = 'decks')}>Linked Anki decks <span class="count">{data.links.length}</span></button>
	</div>

	{#if tab === 'chapters'}
		<section class="card card-flush">
			<div class="card-head row" style="justify-content: space-between">
				<span class="small muted">Check off what you’ve finished. AAMC categories set what cards made in a chapter start with.</span>
				{#if unconfirmed}
					<button type="button" class="btn btn-sm" onclick={() => post({ action: 'accept-suggestions' }, 'Suggestions accepted')}>
						<Icon name="check" size={15} />Accept {unconfirmed} suggested categor{unconfirmed === 1 ? 'y' : 'ies'}
					</button>
				{/if}
			</div>
			{#if data.sections.length}
				{#each groups as g, gi (g.key ?? `g${gi}`)}
					{#if g.key}
						{@const leafIds = g.sections.filter((s) => leaves.has(s.id))}
						{@const doneCount = leafIds.filter((s) => isDone(s)).length}
						<div class="group-head">
							<label class="checkbox">
								<input
									type="checkbox"
									checked={doneCount === leafIds.length && leafIds.length > 0}
									indeterminate={doneCount > 0 && doneCount < leafIds.length}
									onchange={(e) => toggle(g.sections.map((s) => s.id), (e.currentTarget as HTMLInputElement).checked, `Chapter ${g.key}`)}
								/>
								<span class="strong">Chapter {g.key}</span>
							</label>
							<span class="tiny muted mono">{doneCount}/{leafIds.length}</span>
						</div>
					{/if}
					<div class="list">
						{#each g.sections as s (s.id)}
							{@const done = isDone(s)}
							<div class="list-row section" class:done style="padding-left: {(g.key ? 2.25 : 1) + s.level * 1.25}rem">
								<label class="check" title={done ? 'Mark not done' : 'Mark done'}>
									<input type="checkbox" checked={done} onchange={(e) => toggle([s.id], (e.currentTarget as HTMLInputElement).checked, s.title)} />
									<span class="sr-only">{s.title} done</span>
								</label>
								<div style="flex: 1 1 14rem; min-width: 0">
									<div class="list-title sec-title">{s.title}</div>
									<div class="list-sub">pp. {s.pageStart}–{s.pageEnd}</div>
								</div>
								<div class="row-tight codes">
									{#each s.aamcCodes as code (code)}
										<span class="code-tag" title={CATEGORY_SHORT[code] ?? ''}>{code}</span>
									{/each}
									{#if !s.confirmed && s.suggestedCodes.length}
										<button type="button" class="pill pill-sm suggest" title="Suggested from the chapter's keywords: click to accept" onclick={() => setCodes(s.id, s.suggestedCodes.map((x) => x.code))}>
											Suggested: {s.suggestedCodes.map((x) => x.code).join(', ')}
										</button>
									{/if}
								</div>
								<div class="row-tight">
									<a class="icon-btn plain sm" href="/library/{data.book.id}/read?page={s.pageStart}" aria-label="Read {s.title}" title="Read"><Icon name="book" size={15} /></a>
									<button type="button" class="icon-btn plain sm" aria-label="AAMC categories for {s.title}" title="AAMC categories" aria-expanded={editingCodes === s.id} onclick={() => (editingCodes = editingCodes === s.id ? null : s.id)}><Icon name="flag" size={15} /></button>
									{#if data.ai && data.book.status === 'ready'}
										<button type="button" class="icon-btn plain sm" aria-label="Generate from {s.title}" title="Generate cards or questions" onclick={() => openGenerate(s)}><Icon name="sparkle" size={15} /></button>
									{/if}
								</div>
							</div>
							{#if editingCodes === s.id}
								<div class="codes-edit">
									{#each s.aamcCodes as code (code)}
										<span class="pill pill-accent">
											<span class="mono">{code}</span>{CATEGORY_SHORT[code] ?? ''}
											<button type="button" class="chip-x" aria-label="Remove {code}" onclick={() => setCodes(s.id, s.aamcCodes.filter((c) => c !== code))}><Icon name="x" size={12} stroke={2.5} /></button>
										</span>
									{/each}
									<label for="add-{s.id}" class="sr-only">Add a category to {s.title}</label>
									<div style="width: 14rem"><CategorySelect id="add-{s.id}" bind:value={() => adding[s.id] ?? null, (v) => (adding[s.id] = v)} placeholder="Add category…" /></div>
									<button
										type="button"
										class="btn btn-sm"
										disabled={!adding[s.id]}
										onclick={async () => {
											const c = adding[s.id];
											if (!c) return;
											await setCodes(s.id, [...new Set([...s.aamcCodes, c])]);
											adding[s.id] = null;
										}}>Add</button
									>
								</div>
							{/if}
						{/each}
					</div>
				{/each}
			{:else}
				<p class="small muted" style="padding: 0 1rem 1rem">Chapters appear when the book finishes processing.</p>
			{/if}
		</section>
	{:else}
		<section class="stack">
			<div class="row" style="justify-content: space-between">
				<p class="small muted" style="flex: 1 1 24rem">
					Link an Anki deck and its cards follow your progress: a chapter’s cards come out of suspension when you mark it done. Cards you’re already studying, or suspended yourself, are never touched.
				</p>
				<button
					type="button"
					class="btn btn-primary"
					disabled={!data.decks.length}
					onclick={() => {
						editLink = null;
						linkOpen = true;
					}}><Icon name="link" size={16} />Link a deck</button
				>
			</div>
			{#if !data.decks.length}
				<div class="card empty">
					<Icon name="cards" size={26} />
					<h2>No Anki decks yet</h2>
					<p><a href="/cards/import">Import a deck</a> or <a href="/settings/anki">connect Anki</a> first.</p>
				</div>
			{:else if data.links.length}
				<div class="card card-flush">
					<div class="list">
						{#each data.links as l (l.id)}
							<div class="list-row">
								<span class="work-icon"><Icon name="link" size={16} /></span>
								<div style="flex: 1 1 16rem; min-width: 0">
									<div class="list-title truncate">{l.deck.split('::').join(' › ')}</div>
									<div class="list-sub">
										{plural(l.maps.length, 'match')} · {l.counts.matched} of {l.counts.cards} cards matched · {l.counts.ready} ready · {l.counts.suspended} suspended{l.suspendUnread ? ' · unread chapters stay suspended' : ''}
									</div>
								</div>
								<div class="row-tight">
									<a class="btn btn-sm btn-ghost" href="/cards?deck={encodeURIComponent(l.deck)}">Cards</a>
									<button
										type="button"
										class="btn btn-sm"
										onclick={() => {
											editLink = l;
											linkOpen = true;
										}}>Edit</button
									>
									<button
										type="button"
										class="icon-btn plain sm"
										aria-label="Unlink {l.deck}"
										title="Unlink"
										onclick={() => {
											unlinking = l;
											unlinkRestore = true;
											unlinkOpen = true;
										}}><Icon name="x" size={16} /></button
									>
								</div>
							</div>
						{/each}
					</div>
				</div>
			{:else}
				<div class="card empty">
					<Icon name="link" size={26} />
					<h2>No deck linked</h2>
					<p>For example, link an AnKing-style MCAT deck: Medicus matches each chapter to the deck’s tags or subdecks for it, and you confirm.</p>
				</div>
			{/if}
		</section>
	{/if}
</div>

<Modal bind:open={upToOpen} title="Set progress">
	<form
		class="stack-sm"
		id="upto-form"
		onsubmit={(e) => {
			e.preventDefault();
			void saveUpTo(Math.max(1, Math.min(data.book.pageCount ?? upTo, Math.floor(upTo))));
		}}
	>
		<label class="field">
			<span class="label">I’ve read up to page</span>
			<div class="row-tight"><input type="number" class="input mono" style="width: 7rem" min="1" max={data.book.pageCount ?? undefined} bind:value={upTo} /><span class="small muted">of {data.book.pageCount}</span></div>
		</label>
		<p class="hint">Pages 1–{upTo || 1} count as done, and nothing after them. Chapter check marks follow.</p>
	</form>
	{#snippet footer()}
		<button type="button" class="btn" onclick={() => (upToOpen = false)}>Cancel</button>
		<button type="submit" form="upto-form" class="btn btn-primary">Save</button>
	{/snippet}
</Modal>

<ConfirmDialog bind:open={resetOpen} title="Reset progress?" confirmLabel="Reset progress" onconfirm={() => saveUpTo(0)}>
	<p>Every chapter of <strong>{data.book.title}</strong> goes back to not done.{data.links.length ? ' Linked decks follow: never-studied cards of those chapters are suspended again.' : ''}</p>
</ConfirmDialog>

<ConfirmDialog bind:open={unlinkOpen} title="Unlink this deck?" confirmLabel="Unlink" onconfirm={unlink}>
	<p>{unlinking?.deck} stops following this book.</p>
	<label class="checkbox"><input type="checkbox" bind:checked={unlinkRestore} />Unsuspend the cards this link kept suspended</label>
</ConfirmDialog>

<DeleteBookDialog bind:open={deleteOpen} bookId={data.book.id} title={data.book.title} ondeleted={() => goto('/library')} />

<DeckLinkDialog
	bind:open={linkOpen}
	documentId={data.book.id}
	bookTitle={data.book.title}
	decks={data.decks}
	link={editLink}
	ai={data.ai}
	onsaved={refresh}
/>

<Modal bind:open={genOpen} title="Generate from this chapter">
	<div class="stack">
		{#if genSection}<p class="small"><strong>{genSection.title}</strong> · pages {genSection.pageStart}–{genSection.pageEnd}</p>{/if}
		{#if !gen}
			<div class="segmented" role="radiogroup" aria-label="What to generate">
				<button type="button" role="radio" aria-checked={genKind === 'card'} onclick={() => (genKind = 'card')}>Flashcards</button>
				<button type="button" role="radio" aria-checked={genKind === 'question'} onclick={() => (genKind = 'question')}>Quiz questions</button>
				<button type="button" role="radio" aria-checked={genKind === 'note'} onclick={() => (genKind = 'note')}>Notes</button>
			</div>
			<div class="field">
				<label for="gen-count">How many (at most)</label>
				<input id="gen-count" type="number" min="1" max="20" class="input mono" style="width: 6rem" bind:value={genCount} />
			</div>
			<p class="small muted">Up to 24 passages from this chapter are sent to your AI service. Each item is checked against them and waits under Tutor › Approvals.</p>
		{:else if gen.status === 'failed'}
			<div class="error-box" role="alert"><Icon name="alert" size={16} />{gen.error ?? 'Generation failed.'}</div>
		{:else if gen.status === 'done'}
			<div class="notice"><Icon name="check" size={16} />{gen.items} item{gen.items === 1 ? '' : 's'} ready for review{gen.flagged ? `, ${gen.flagged} flagged by the checks` : ''}.</div>
		{:else}
			<p class="small">Writing and checking… this can take a minute. You can close this; the items will wait under Tutor › Approvals.</p>
			<div class="bar"><span style="width: 60%"></span></div>
		{/if}
	</div>
	{#snippet footer()}
		<span class="spacer"></span>
		{#if !gen}
			<button type="button" class="btn" onclick={() => (genOpen = false)}>Cancel</button>
			<button type="button" class="btn btn-navy" onclick={startGenerate}><Icon name="sparkle" size={15} />Generate</button>
		{:else if gen.status === 'done'}
			<button type="button" class="btn" onclick={() => (genOpen = false)}>Close</button>
			<a class="btn btn-primary" href="/tutor/queue">Review them</a>
		{:else}
			<button type="button" class="btn" onclick={() => (genOpen = false)}>Close</button>
		{/if}
	{/snippet}
</Modal>

<style>
	.book-page {
		max-width: 60rem;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		color: var(--text-3);
		text-decoration: none;
		align-self: flex-start;
		margin-bottom: -0.5rem;
	}
	.back:hover {
		color: var(--text);
	}
	.menu-wrap {
		position: relative;
	}
	.prog-top {
		display: flex;
		flex-wrap: wrap;
		align-items: flex-end;
		justify-content: space-between;
		gap: 0.75rem;
	}
	.prog-num {
		font-size: 1.25rem;
		font-weight: 600;
		margin-top: 0.25rem;
	}
	.group-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.25rem 1rem;
		background: var(--surface-2);
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
	}
	.group-head .checkbox {
		min-height: 2rem;
	}
	.section {
		flex-wrap: nowrap;
		gap: 0.625rem;
	}
	.section.done .sec-title {
		color: var(--text-3);
	}
	.check {
		display: inline-flex;
		align-items: center;
		cursor: pointer;
		flex: none;
	}
	.check input {
		width: 1rem;
		height: 1rem;
		accent-color: var(--accent);
		margin: 0;
	}
	.codes {
		flex: 0 1 auto;
		justify-content: flex-end;
	}
	.suggest {
		border: 1px dashed var(--border-strong);
		background: transparent;
		cursor: pointer;
	}
	.codes-edit {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
		padding: 0.5rem 1rem 0.75rem 3.25rem;
		border-bottom: 1px solid var(--border);
		background: var(--hover);
	}
	.chip-x {
		border: 0;
		background: transparent;
		color: inherit;
		cursor: pointer;
		padding: 0 0 0 2px;
		display: inline-flex;
		align-items: center;
	}
	.work-icon {
		width: 1.75rem;
		height: 1.75rem;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		color: var(--text-2);
		display: flex;
		align-items: center;
		justify-content: center;
		flex: none;
	}
	@media (max-width: 640px) {
		.section {
			flex-wrap: wrap;
		}
		.codes {
			width: 100%;
			justify-content: flex-start;
			padding-left: 1.625rem;
		}
	}
</style>
