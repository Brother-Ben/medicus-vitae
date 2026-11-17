<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import CardEditor, { type CardContext, type CardDraft } from '#lib/components/CardEditor.svelte';
	import CardsTabs from '#lib/components/CardsTabs.svelte';
	import CategorySelect from '#lib/components/CategorySelect.svelte';
	import CodeTag from '#lib/components/CodeTag.svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import DueDateDialog from '#lib/components/DueDateDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { floatMenu } from '#lib/client/float-menu.js';
	import { api } from '#lib/client/api.js';
	import { toast, toastAction, toastError } from '#lib/client/toast.svelte.js';
	import { CATEGORY_SHORT } from '#lib/aamc.js';
	import { STATE_LABELS } from '#lib/cards.js';
	import { relativeTime } from '#lib/dates.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let q = $derived(data.q);
	let aamc = $derived<string | null>(data.aamc);
	let deck = $derived<string>(data.deck ?? '');
	let editorOpen = $state(false);
	let draft = $state<CardDraft>({ kind: 'basic', fields: {}, aamcCode: null, tags: [] });
	let editNoteId = $state<string | null>(null);
	let context = $state<CardContext | null>(null);

	// Open the editor once for a card linked with ?note= (not again after every refresh).
	let openedFromLink = '';
	$effect(() => {
		const n = data.editNote;
		if (n && n.noteId !== openedFromLink) {
			openedFromLink = n.noteId;
			draft = { kind: n.kind, fields: { ...n.fields }, aamcCode: n.aamcCode, tags: [...n.tags], fieldNames: n.fieldNames, noteTypeName: n.noteTypeName, noteTypeId: n.noteTypeId, noteTypeSource: n.noteTypeSource };
			editNoteId = n.noteId;
			context = n.source ? { passage: n.source.exact, label: n.source.label, available: n.source.available } : null;
			editorOpen = true;
		}
	});

	function href(patch: Record<string, string | null>) {
		const p = new URLSearchParams();
		const merged: Record<string, string | null> = { q: data.q || null, state: data.state, aamc: data.aamc, doc: data.docId, deck: data.deck, ...patch };
		for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
		const s = p.toString();
		return s ? `/cards?${s}` : '/cards';
	}

	const refresh = () => invalidate('app:cards');

	async function edit(noteId: string) {
		try {
			const r = await api<{ note: NonNullable<typeof data.editNote> }>(`/api/cards?noteId=${noteId}`);
			draft = {
				kind: r.note.kind,
				fields: { ...r.note.fields },
				aamcCode: r.note.aamcCode,
				tags: [...r.note.tags],
				fieldNames: r.note.fieldNames,
				noteTypeName: r.note.noteTypeName,
				noteTypeId: r.note.noteTypeId,
				noteTypeSource: r.note.noteTypeSource
			};
			editNoteId = noteId;
			context = r.note.source ? { passage: r.note.source.exact, label: r.note.source.label, available: r.note.source.available } : null;
			editorOpen = true;
		} catch (err) {
			toastError(err);
		}
	}

	function newCard() {
		draft = { kind: 'basic', fields: {}, aamcCode: data.aamc, tags: [] };
		editNoteId = null;
		context = null;
		editorOpen = true;
	}

	async function suspend(cardIds: string[], suspended: boolean) {
		try {
			const r = await api<{ batchId: string; changed: number }>('/api/cards', { method: 'PATCH', body: { cardIds, suspended } });
			await refresh();
			const n = r.changed;
			toastAction(`${n} card${n === 1 ? '' : 's'} ${suspended ? 'suspended' : 'back in your reviews'}`, {
				label: 'Undo',
				run: async () => {
					await api('/api/cards', { method: 'PATCH', body: { undoBatch: r.batchId } });
					await refresh();
				}
			});
		} catch (err) {
			toastError(err);
		}
	}

	// Deleting a card (its note: a reverse or other cloze cards go with it).
	let delCard = $state<(typeof data.list.items)[number] | null>(null);
	let delCardOpen = $state(false);
	let delInAnki = $state(false);
	async function removeCard() {
		if (!delCard) return;
		const r = await api<{ deleted: unknown; anki: { ok: boolean; message: string } | null }>('/api/cards', {
			method: 'PATCH',
			body: { noteId: delCard.noteId, delete: true, alsoInAnki: delInAnki }
		});
		await refresh();
		if (r.anki && !r.anki.ok) toast(r.anki.message, 'error');
		toastAction('Card deleted', {
			label: 'Undo',
			run: async () => {
				await api('/api/cards', { method: 'PATCH', body: { restore: r.deleted } });
				toast(r.anki?.ok ? 'Card restored here (it stays deleted in Anki)' : 'Card restored');
				await refresh();
			}
		});
	}

	// Deleting a deck.
	let delDeck = $state<{ deck: string; label: string } | null>(null);
	let delDeckOpen = $state(false);
	let delDeckInfo = $state<{ cards: number; notes: number; reviews: number; inAnki: number; synced: boolean } | null>(null);
	let delDeckInAnki = $state(false);
	let delDeckTyped = $state('');
	async function openDeleteDeck(d: { deck: string; label: string }) {
		delDeck = d;
		delDeckInfo = null;
		delDeckInAnki = false;
		delDeckTyped = '';
		delDeckOpen = true;
		try {
			delDeckInfo = await api(`/api/decks?deck=${encodeURIComponent(d.deck)}`);
		} catch (err) {
			toastError(err);
		}
	}
	async function removeDeck() {
		if (!delDeck) return;
		const r = await api<{ deleted: unknown; cards: number; anki: { ok: boolean; message: string } | null }>('/api/decks', {
			body: { action: 'delete', deck: delDeck.deck, alsoInAnki: delDeckInAnki }
		});
		if (data.deck === delDeck.deck || data.deck?.startsWith(delDeck.deck + '::')) await goto('/cards');
		await refresh();
		if (r.anki && !r.anki.ok) toast(r.anki.message, 'error');
		toastAction(`Deleted ${delDeck.label} (${r.cards} card${r.cards === 1 ? '' : 's'})`, {
			label: 'Undo',
			run: async () => {
				await api('/api/decks', { body: { action: 'restore', deleted: r.deleted } });
				toast(r.anki?.ok ? 'Deck restored here (it stays deleted in Anki)' : 'Deck restored');
				await refresh();
			}
		});
	}

	async function markFixed(cardId: string) {
		try {
			await api('/api/cards', { method: 'PATCH', body: { cardId, leech: false } });
			toast('Leech flag cleared');
			await refresh();
		} catch (err) {
			toastError(err);
		}
	}

	const tabs = $derived([
		{ v: null, l: 'All' },
		{ v: 'due', l: 'Due' },
		{ v: 'new', l: 'New' },
		{ v: 'learning', l: 'Learning' },
		{ v: 'review', l: 'Review' },
		{ v: 'suspended', l: 'Suspended' },
		...(data.leeches || data.state === 'leech' ? [{ v: 'leech', l: `Leeches · ${data.leeches}` }] : [])
	]);

	function kindLabel(c: (typeof data.list.items)[number]) {
		if (c.kind === 'anki') return c.deck ? 'Anki' : 'Anki note';
		return c.kind === 'cloze' ? `Cloze ${c.ord + 1}` : c.kind === 'basic_reversed' ? (c.ord ? 'Reverse' : 'Forward') : 'Basic';
	}

	// Deck list: top-level decks start folded; open one to see its subdecks.
	let openDecks = $state<Record<string, boolean>>({});
	const visibleDecks = $derived(
		data.decks.filter((d) => {
			const parts = d.deck.split('::');
			for (let i = 1; i < parts.length; i++) if (!openDecks[parts.slice(0, i).join('::')]) return false;
			return true;
		})
	);
	let deckMenu = $state<string | null>(null);
	// Set due date: one card, the ticked cards, or a whole deck.
	let selected = $state<Record<string, boolean>>({});
	const selectedIds = $derived(Object.keys(selected).filter((k) => selected[k]));
	let dueOpen = $state(false);
	let dueTarget = $state<{ cardIds: string[]; deck: string | null; label: string }>({ cardIds: [], deck: null, label: '' });
	function openDue(target: { cardIds?: string[]; deck?: string | null; label: string }) {
		dueTarget = { cardIds: target.cardIds ?? [], deck: target.deck ?? null, label: target.label };
		dueOpen = true;
	}
	const allShownSelected = $derived(data.list.items.length > 0 && data.list.items.every((c) => selected[c.cardId]));
	function toggleAll(on: boolean) {
		const next: Record<string, boolean> = { ...selected };
		for (const c of data.list.items) next[c.cardId] = on;
		selected = next;
	}

	const studyHref = (deck: string) => `/review?deck=${encodeURIComponent(deck)}`;
	const studyNowHref = $derived(
		data.deck ? studyHref(data.deck) : data.aamc ? `/review?aamc=${data.aamc}` : data.docId ? `/review?doc=${data.docId}` : '/review'
	);
	const linkedTo = (deck: string) => data.links.filter((l) => l.deck === deck);
</script>

<svelte:window onclick={() => (deckMenu = null)} />

<svelte:head><title>Flashcards · Medicus Vitae</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div>
			<h1>Flashcards</h1>
			<div class="subtitle">
				{data.list.total} card{data.list.total === 1 ? '' : 's'}{data.docTitle ? ` from ${data.docTitle}` : ''}{data.aamc ? ` in ${data.aamc} ${CATEGORY_SHORT[data.aamc] ?? ''}` : ''}{data.deck
					? ` in ${data.deck.split('::').join(' › ')}`
					: ''}
			</div>
		</div>
		<div class="row-tight">
			<a class="btn" href="/cards/import"><Icon name="upload" size={16} />Import from Anki</a>
			<button type="button" class="btn" onclick={newCard}><Icon name="plus" size={16} />New card</button>
			<a class="btn btn-primary" href={studyNowHref}>
				<Icon name="play" size={16} />Study {data.deck ? 'this deck' : 'now'}{data.counts.total ? ` · ${data.counts.total}` : ''}
			</a>
		</div>
	</header>

	<CardsTabs carsWaiting={data.carsWaiting} />

	{#if data.decks.length}
		<section class="card card-flush" aria-labelledby="decks-h">
			<div class="card-head row" style="justify-content: space-between">
				<h2 id="decks-h" class="section-label">Decks</h2>
				<span class="tiny muted">{data.newLimitLeft} new card{data.newLimitLeft === 1 ? '' : 's'} left today</span>
			</div>
			<div class="deck-list" role="list">
				<div class="deck-row deck-head tiny muted" aria-hidden="true">
					<span class="deck-toggle"></span><span class="deck-name-head">Deck</span>
					<span class="deck-counts mono"><span>New</span><span>Learn</span><span>Due</span></span>
					<span class="study-gap"></span>
				</div>
				{#each visibleDecks as d (d.deck)}
					<div class="deck-row" role="listitem" style="padding-left: calc(0.5rem + {d.depth * 1.25}rem)" class:current={data.deck === d.deck}>
						{#if d.hasChildren}
							<button
								type="button"
								class="icon-btn plain sm deck-toggle"
								aria-expanded={!!openDecks[d.deck]}
								aria-label="{openDecks[d.deck] ? 'Hide' : 'Show'} subdecks of {d.label}"
								onclick={() => (openDecks[d.deck] = !openDecks[d.deck])}
							>
								<Icon name={openDecks[d.deck] ? 'chevron-down' : 'chevron-right'} size={15} />
							</button>
						{:else}
							<span class="deck-toggle" aria-hidden="true"></span>
						{/if}
						<a class="deck-name" href={href({ deck: d.deck, state: null, q: null })} title="Show this deck’s cards">{d.label}</a>
						{#if linkedTo(d.deck).length}
							<span class="pill pill-sm linked" title="Follows your progress in {linkedTo(d.deck).map((l) => l.documentTitle).join(', ')}"><Icon name="link" size={11} />{linkedTo(d.deck)[0].documentTitle}</span>
						{/if}
						<span class="deck-counts mono small" aria-label="{Math.min(d.new, data.newLimitLeft)} new, {d.learning} learning, {d.review} due for review">
							<span class="c-new" title="New">{Math.min(d.new, data.newLimitLeft)}</span>
							<span class="c-learn" title="Learning">{d.learning}</span>
							<span class="c-review" title="Due for review">{d.review}</span>
						</span>
						<a class="btn btn-sm btn-ghost" href={studyHref(d.deck)} aria-label="Study {d.label}">Study</a>
						<div class="menu-wrap">
							<button
								type="button"
								class="icon-btn plain sm"
								aria-label="More for {d.label}"
								aria-haspopup="menu"
								aria-expanded={deckMenu === d.deck}
								onclick={(e) => {
									e.stopPropagation();
									deckMenu = deckMenu === d.deck ? null : d.deck;
								}}><Icon name="more" size={17} /></button
							>
							{#if deckMenu === d.deck}
								<div class="menu" role="menu" use:floatMenu>
									<a role="menuitem" href={studyHref(d.deck)}><Icon name="play" size={15} />Study</a>
									<button type="button" role="menuitem" onclick={() => openDue({ deck: d.deck, label: d.label })}><Icon name="calendar" size={15} />Set due date…</button>
									<a role="menuitem" href={href({ deck: d.deck, state: 'suspended', q: null })}><Icon name="pause" size={15} />Suspended cards</a>
									{#each linkedTo(d.deck) as l (l.id)}
										<a role="menuitem" href="/library/{l.documentId}#decks"><Icon name="link" size={15} />Linked to {l.documentTitle}</a>
									{:else}
										<a role="menuitem" href="/library"><Icon name="link" size={15} />Link to a book…</a>
									{/each}
									<hr />
									<button type="button" role="menuitem" class="danger" onclick={() => openDeleteDeck(d)}><Icon name="trash" size={15} />Delete deck…</button>
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}

	<div class="row filters" style="justify-content: space-between">
		<div class="segmented" role="tablist" aria-label="Card state">
			{#each tabs as t (t.l)}
				<a href={href({ state: t.v })} aria-current={data.state === t.v ? 'page' : undefined}>{t.l}</a>
			{/each}
		</div>
		<form
			class="row-tight"
			role="search"
			onsubmit={(e) => {
				e.preventDefault();
				void goto(href({ q: q.trim() || null, aamc, deck: deck || null }));
			}}
		>
			<label for="card-q" class="sr-only">Search cards</label>
			<input id="card-q" class="input" style="width: 13rem" bind:value={q} placeholder="Search cards" />
			<div style="width: 11rem"><CategorySelect id="card-aamc" bind:value={aamc} placeholder="All categories" /></div>
			{#if data.decks.length}
				<label for="card-deck" class="sr-only">Anki deck</label>
				<select id="card-deck" class="select" style="width: 12rem" bind:value={deck}>
					<option value="">All decks</option>
					{#each data.decks as d (d.deck)}<option value={d.deck}>{'  '.repeat(d.depth)}{d.label} ({d.cards})</option>{/each}
				</select>
			{/if}
			<button class="btn">Apply</button>
			{#if data.q || data.aamc || data.docId || data.deck}<a class="btn btn-ghost" href="/cards">Clear</a>{/if}
		</form>
	</div>

	{#if data.list.items.length}
		<div class="card card-flush">
			<div class="select-bar" class:active={selectedIds.length > 0}>
				<label class="checkbox small" style="min-height: 2rem">
					<input type="checkbox" checked={allShownSelected} onchange={(e) => toggleAll((e.currentTarget as HTMLInputElement).checked)} />
					{selectedIds.length ? `${selectedIds.length} selected` : 'Select all shown'}
				</label>
				{#if selectedIds.length}
					<button type="button" class="btn btn-sm" onclick={() => openDue({ cardIds: selectedIds, label: `${selectedIds.length} selected card${selectedIds.length === 1 ? '' : 's'}` })}>
						<Icon name="calendar" size={15} />Set due date
					</button>
					<button type="button" class="btn btn-sm" onclick={() => suspend(selectedIds, true).then(() => (selected = {}))}><Icon name="pause" size={15} />Suspend</button>
					<button type="button" class="btn btn-sm" onclick={() => suspend(selectedIds, false).then(() => (selected = {}))}><Icon name="play" size={15} />Unsuspend</button>
					<button type="button" class="btn btn-sm btn-ghost" onclick={() => (selected = {})}>Clear selection</button>
				{/if}
			</div>
			<div class="list">
				{#each data.list.items as c (c.cardId)}
					<div class="list-row card-row" class:is-suspended={c.suspended}>
						<input
							type="checkbox"
							class="row-check"
							aria-label="Select card: {c.preview || 'empty card'}"
							checked={!!selected[c.cardId]}
							onchange={(e) => (selected = { ...selected, [c.cardId]: (e.currentTarget as HTMLInputElement).checked })}
						/>
						<button type="button" class="card-main" onclick={() => edit(c.noteId)} title="Edit">
							<span class="list-title">{c.preview || '(empty)'}</span>
							<span class="list-sub">
								{kindLabel(c)} · {c.suspended ? 'Suspended' : STATE_LABELS[c.state]}{!c.suspended && c.state !== 0 ? ` · due ${relativeTime(c.due)}` : ''}{!c.suspended && c.state === 0 && c.due > Date.now()
									? ` · starts ${relativeTime(c.due)}`
									: ''}{c.lapses ? ` · forgotten ${c.lapses}×` : ''}{c.deck ? ` · ${c.deck.split('::').pop()}` : ''}
								{#if c.source}· <span class:missing-src={c.sourceAvailable === false}>{c.sourceAvailable === false ? 'Source missing: ' : ''}{c.source}</span>{/if}
							</span>
						</button>
						{#if c.leech}<span class="pill pill-warn pill-sm" title="Forgotten many times: worth rewriting or splitting">Leech</span>{/if}
						{#if c.aamcCode}<CodeTag code={c.aamcCode} />{/if}
						<div class="row-tight row-actions">
							{#if c.leech}<button type="button" class="btn btn-sm btn-ghost" onclick={() => markFixed(c.cardId)}>Mark fixed</button>{/if}
							{#if !c.suspended}
								<button type="button" class="icon-btn plain sm" title="Set due date" aria-label="Set due date" onclick={() => openDue({ cardIds: [c.cardId], label: 'This card' })}>
									<Icon name="calendar" size={15} />
								</button>
							{/if}
							<button type="button" class="icon-btn plain sm" title={c.suspended ? 'Unsuspend' : 'Suspend'} aria-label={c.suspended ? 'Unsuspend' : 'Suspend'} onclick={() => suspend([c.cardId], !c.suspended)}>
								<Icon name={c.suspended ? 'play' : 'pause'} size={15} />
							</button>
							<button
								type="button"
								class="icon-btn plain sm"
								title="Delete"
								aria-label="Delete card"
								onclick={() => {
									delCard = c;
									delInAnki = false;
									delCardOpen = true;
								}}><Icon name="trash" size={15} /></button
							>
						</div>
					</div>
				{/each}
			</div>
		</div>
		{#if data.list.total > data.list.items.length}
			<a class="btn" style="align-self: center" href={href({ limit: String(data.limit + 100) })}>Show more ({data.list.total - data.list.items.length} left)</a>
		{/if}
	{:else}
		<div class="card empty">
			<Icon name="cards" size={28} />
			<h2>{data.q || data.state || data.aamc || data.deck ? 'No cards match' : 'No cards yet'}</h2>
			<p>Select text in a book and choose <strong>Make card</strong>, create one here, or <a href="/cards/import">import an Anki deck</a>.</p>
		</div>
	{/if}
</div>

<CardEditor bind:open={editorOpen} {draft} noteId={editNoteId} {context} onsaved={() => refresh()} />
<DueDateDialog
	bind:open={dueOpen}
	today={data.today}
	cardIds={dueTarget.cardIds}
	deck={dueTarget.deck}
	label={dueTarget.label}
	onsaved={() => {
		selected = {};
		void refresh();
	}}
/>

<ConfirmDialog bind:open={delCardOpen} title="Delete this card?" confirmLabel="Delete card" onconfirm={removeCard}>
	{#if delCard}
		<p class="truncate"><strong>{delCard.preview || '(empty)'}</strong></p>
		<p class="small">
			{delCard.kind === 'basic_reversed' || delCard.kind === 'cloze' || delCard.kind === 'anki' ? 'Its other cards from the same note (reverse, other clozes) go too. ' : ''}It won’t come up again; its review history is kept so Undo brings it back as it was.
		</p>
		{#if delCard.origin === 'anki' || delCard.deck}
			<label class="checkbox"><input type="checkbox" bind:checked={delInAnki} />Also delete it in Anki (Anki must be open)</label>
		{/if}
	{/if}
</ConfirmDialog>

<ConfirmDialog
	bind:open={delDeckOpen}
	title="Delete this deck?"
	confirmLabel="Delete deck"
	disabled={!delDeckInfo || (delDeckInfo.cards > 50 && delDeckTyped.trim() !== delDeck?.label)}
	onconfirm={removeDeck}
>
	{#if delDeck}
		<p><strong>{delDeck.deck.split('::').join(' › ')}</strong> and its subdecks will be deleted{delDeckInfo ? `: ${delDeckInfo.cards} card${delDeckInfo.cards === 1 ? '' : 's'}${delDeckInfo.reviews ? ` with ${delDeckInfo.reviews} reviews` : ''}` : ''}.</p>
		<p class="small">Undo brings it all back. A snapshot is taken first too.{delDeckInfo?.synced ? ' Anki sync stops following this deck.' : ''}</p>
		{#if delDeckInfo?.inAnki}
			<label class="checkbox"><input type="checkbox" bind:checked={delDeckInAnki} />Also delete the deck in Anki (Anki must be open; Undo can’t bring it back there)</label>
		{/if}
		{#if delDeckInfo && delDeckInfo.cards > 50}
			<label class="field">
				<span class="label">Type <span class="mono">{delDeck.label}</span> to confirm</span>
				<input class="input" bind:value={delDeckTyped} autocomplete="off" />
			</label>
		{/if}
	{/if}
</ConfirmDialog>

<style>
	.select-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
		padding: 0.375rem 1rem;
		border-bottom: 1px solid var(--border);
		background: var(--surface);
		position: sticky;
		top: 0;
		z-index: 2;
	}
	.select-bar.active {
		background: var(--accent-soft);
	}
	.row-check {
		width: 1rem;
		height: 1rem;
		accent-color: var(--accent);
		flex: none;
	}
	.card-row {
		flex-wrap: nowrap;
		gap: 0.625rem;
	}
	.card-row.is-suspended .list-title {
		color: var(--text-3);
	}
	.card-main {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		text-align: left;
		border: 0;
		background: transparent;
		padding: 0;
		cursor: pointer;
		color: inherit;
	}
	.card-main .list-title {
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.card-main:hover .list-title {
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.row-actions {
		flex: none;
		flex-wrap: nowrap;
	}
	.missing-src {
		color: var(--weak-text);
	}
	.deck-list {
		display: flex;
		flex-direction: column;
	}
	.deck-row {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		min-height: 2.5rem;
		padding-right: 0.5rem;
		border-top: 1px solid var(--border);
	}
	.deck-row:hover {
		background: var(--hover);
	}
	.deck-row.current .deck-name {
		color: var(--accent-text);
	}
	.deck-toggle {
		width: var(--control-h-sm);
		height: var(--control-h-sm);
		flex: none;
	}
	.deck-name {
		flex: 1 1 auto;
		min-width: 0;
		font-weight: 600;
		color: var(--text);
		text-decoration: none;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.deck-name:hover {
		text-decoration: underline;
	}
	.linked {
		max-width: 12rem;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.deck-counts {
		display: inline-flex;
		gap: 0.5rem;
		flex: none;
	}
	.deck-head {
		min-height: 1.75rem;
		font-weight: 600;
		padding-left: 0.5rem;
		border-top: 0;
	}
	.deck-head:hover {
		background: transparent;
	}
	.deck-name-head {
		flex: 1 1 auto;
	}
	/* Lines the column labels up with the counts (the Study button and menu's width). */
	.study-gap {
		width: calc(3.5rem + var(--control-h-sm) + 0.75rem);
		flex: none;
	}
	.deck-counts span {
		min-width: 2.25rem;
		text-align: right;
	}
	.c-new {
		color: var(--accent-text);
	}
	.c-learn {
		color: var(--text);
	}
	.c-review {
		color: var(--text-2);
	}
	.menu-wrap {
		position: relative;
	}
	@media (max-width: 560px) {
		.deck-counts span {
			min-width: 1.5rem;
		}
		.linked {
			display: none;
		}
	}
</style>
