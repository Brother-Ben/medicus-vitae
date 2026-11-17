<script lang="ts">
	import { api } from '#lib/client/api.js';
	import { toast, toastAction, toastError } from '#lib/client/toast.svelte.js';
	import Icon from './Icon.svelte';
	import Modal from './Modal.svelte';
	import { untrack } from 'svelte';

	// Link an Anki deck to a book: each chapter is matched to the deck's tags or
	// subdecks for it (suggested by name, or by the AI), the owner adjusts the
	// matches, sees what saving will do, and saves.

	interface MapRow {
		targetKind: 'tag' | 'deck';
		target: string;
		pageFrom: number;
		pageTo: number;
		label?: string;
	}
	interface Candidate {
		kind: 'tag' | 'deck';
		target: string;
		label: string;
		cards: number;
		depth: number;
	}
	interface SectionMatch {
		sectionId: string;
		title: string;
		pageStart: number;
		pageEnd: number;
		chapter: string | null;
		options: (Candidate & { score: number })[];
	}

	let {
		open = $bindable(false),
		documentId,
		bookTitle,
		decks,
		link = null,
		ai = false,
		onsaved
	}: {
		open?: boolean;
		documentId: string;
		bookTitle: string;
		decks: { deck: string; label: string; depth: number; cards: number }[];
		link?: { id: string; deck: string; suspendUnread: boolean; maps: MapRow[] } | null;
		ai?: boolean;
		onsaved?: () => void | Promise<void>;
	} = $props();

	let deck = $state('');
	let maps = $state<MapRow[]>([]);
	let suspendUnread = $state(true);
	let sections = $state<SectionMatch[]>([]);
	let candidates = $state<Candidate[]>([]);
	let auto = $state<MapRow[]>([]);
	let loading = $state(false);
	let aiBusy = $state(false);
	let saving = $state(false);
	let error = $state('');
	let preview = $state<{ cards: number; matched: number; ready: number; willUnsuspend: number; willSuspend: number } | null>(null);
	let picking = $state<Record<string, string>>({});
	let onlyUnmatched = $state(false);

	// Reset each time the dialog opens. Only `open` and `link` are tracked: picking
	// another deck must not send the dialog back to its first deck.
	$effect(() => {
		if (!open) return;
		const current = link;
		untrack(() => {
			error = '';
			preview = null;
			if (current) {
				deck = current.deck;
				maps = current.maps.map((m) => ({ ...m }));
				suspendUnread = current.suspendUnread;
				void load(current.deck, false);
			} else {
				deck = decks.find((d) => d.depth === 0)?.deck ?? decks[0]?.deck ?? '';
				suspendUnread = true;
				maps = [];
				if (deck) void load(deck, true);
			}
		});
	});

	async function load(d: string, useAuto: boolean) {
		loading = true;
		try {
			const r = await api<{ sections: SectionMatch[]; candidates: Candidate[]; maps: MapRow[] }>(`/api/deck-links?documentId=${encodeURIComponent(documentId)}&deck=${encodeURIComponent(d)}`);
			sections = r.sections;
			candidates = r.candidates;
			auto = r.maps;
			if (useAuto) maps = r.maps.map((m) => ({ ...m }));
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			loading = false;
		}
	}

	const key = (m: { pageFrom: number; pageTo: number }) => `${m.pageFrom}-${m.pageTo}`;
	const mapsFor = (s: SectionMatch) => maps.filter((m) => m.pageFrom === s.pageStart && m.pageTo === s.pageEnd);
	const others = $derived(maps.filter((m) => !sections.some((s) => s.pageStart === m.pageFrom && s.pageEnd === m.pageTo)));
	const matchedSections = $derived(sections.filter((s) => mapsFor(s).length).length);
	const shown = $derived(onlyUnmatched ? sections.filter((s) => !mapsFor(s).length) : sections);
	const byTarget = $derived(new Map(candidates.map((c) => [`${c.kind}:${c.target}`, c])));

	function remove(m: MapRow) {
		maps = maps.filter((x) => x !== m);
	}

	function add(s: SectionMatch, value: string) {
		if (!value) return;
		const kind: 'tag' | 'deck' = value.startsWith('deck:') ? 'deck' : 'tag';
		const target = value.replace(/^(deck|tag):/, '');
		if (mapsFor(s).some((m) => m.targetKind === kind && m.target === target)) return;
		maps = [...maps, { targetKind: kind, target, pageFrom: s.pageStart, pageTo: s.pageEnd, label: s.title }];
		picking[s.sectionId] = '';
	}

	// The preview follows every change, a moment later.
	let timer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		const body = { action: 'preview', documentId, deck, maps: $state.snapshot(maps), suspendUnread };
		if (!open || !deck) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(async () => {
			try {
				preview = await api('/api/deck-links', { body });
			} catch {
				preview = null;
			}
		}, 350);
	});

	async function aiSuggest() {
		aiBusy = true;
		error = '';
		try {
			const r = await api<{ maps: MapRow[] }>('/api/deck-links', { body: { action: 'ai-suggest', documentId, deck } });
			if (!r.maps.length) toast('The AI found no good matches.');
			else {
				maps = r.maps;
				toast(`${r.maps.length} matches from the AI. Check them before saving.`);
			}
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			aiBusy = false;
		}
	}

	async function save() {
		saving = true;
		error = '';
		try {
			const r = await api<{ summary: { batchId: string; unsuspended: number; suspended: number } }>('/api/deck-links', {
				body: { action: 'save', linkId: link?.id ?? null, documentId, deck, maps: $state.snapshot(maps), suspendUnread }
			});
			open = false;
			await onsaved?.();
			const s = r.summary;
			const parts = [s.unsuspended ? `${s.unsuspended} unsuspended` : '', s.suspended ? `${s.suspended} suspended` : ''].filter(Boolean).join(', ');
			if (parts) {
				toastAction(`${link ? 'Link saved' : `Linked ${deck.split('::').pop()}`} · ${parts}`, {
					label: 'Undo cards',
					run: async () => {
						try {
							await api('/api/deck-links', { body: { action: 'undo', batchId: s.batchId } });
							toast('Cards put back');
							await onsaved?.();
						} catch (err) {
							toastError(err);
						}
					}
				});
			} else toast(link ? 'Link saved' : 'Deck linked');
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			saving = false;
		}
	}

	const label = (m: MapRow) => byTarget.get(`${m.targetKind}:${m.target}`)?.label ?? m.target.split('::').pop()?.replace(/_/g, ' ') ?? m.target;
	const countOf = (m: MapRow) => byTarget.get(`${m.targetKind}:${m.target}`)?.cards ?? 0;
</script>

<Modal bind:open title={link ? 'Edit deck link' : 'Link an Anki deck'} wide>
	<div class="stack">
		<div class="form-grid">
			<div class="field">
				<label for="link-deck">Deck</label>
				<select
					id="link-deck"
					class="select"
					bind:value={deck}
					disabled={!!link}
					onchange={() => {
						maps = [];
						void load(deck, true);
					}}
				>
					{#each decks as d (d.deck)}<option value={d.deck}>{'  '.repeat(d.depth)}{d.label} ({d.cards})</option>{/each}
				</select>
			</div>
			<div class="field">
				<span class="label">Book</span>
				<div class="static truncate">{bookTitle}</div>
			</div>
		</div>

		<div class="row" style="justify-content: space-between">
			<div class="small">
				{#if loading}Finding matches…{:else}<strong>{matchedSections}</strong> of {sections.length} chapters matched{/if}
			</div>
			<div class="row-tight">
				<label class="checkbox small" style="min-height: 0"><input type="checkbox" bind:checked={onlyUnmatched} />Only unmatched</label>
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => (maps = auto.map((m) => ({ ...m })))} disabled={loading}>Suggest by name</button>
				{#if ai}<button type="button" class="btn btn-sm" onclick={aiSuggest} disabled={aiBusy || loading}><Icon name="sparkle" size={14} />{aiBusy ? 'Matching…' : 'Match with AI'}</button>{/if}
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => (maps = [])}>Clear</button>
			</div>
		</div>

		<datalist id="link-candidates">
			{#each candidates as c (c.kind + c.target)}<option value={c.kind === 'deck' ? `deck: ${c.target}` : c.target}>{c.cards} cards</option>{/each}
		</datalist>
		<div class="map-list" aria-busy={loading}>
			{#each shown as s (s.sectionId)}
				{@const mine = mapsFor(s)}
				<div class="map-row" class:none={!mine.length}>
					<div class="sec">
						<div class="strong truncate" title={s.title}>{s.title}</div>
						<div class="tiny muted">pp. {s.pageStart}–{s.pageEnd}</div>
					</div>
					<div class="targets">
						{#each mine as m (m.targetKind + m.target)}
							<span class="target" title={m.target}>
								<Icon name={m.targetKind === 'deck' ? 'folder' : 'flag'} size={12} />
								<span class="truncate">{label(m)}</span>
								<span class="mono tiny muted">{countOf(m)}</span>
								<button type="button" aria-label="Remove {m.target}" onclick={() => remove(m)}><Icon name="x" size={11} stroke={2.5} /></button>
							</span>
						{/each}
						{#if s.options.some((o) => !mine.some((m) => m.targetKind === o.kind && m.target === o.target))}
							<select
								class="select input-sm pick"
								aria-label="Add a suggested match for {s.title}"
								value=""
								onchange={(e) => add(s, (e.currentTarget as HTMLSelectElement).value)}
							>
								<option value="">{mine.length ? 'Add a guess…' : 'Best guesses…'}</option>
								{#each s.options.filter((o) => !mine.some((m) => m.targetKind === o.kind && m.target === o.target)) as o (o.kind + o.target)}
									<option value="{o.kind}:{o.target}">{o.target.replace(/_/g, ' ')} ({o.cards})</option>
								{/each}
							</select>
						{/if}
						<input
							class="input input-sm pick"
							list="link-candidates"
							placeholder="Search tags…"
							aria-label="Search all tags and subdecks for {s.title}"
							bind:value={() => picking[s.sectionId] ?? '', (v) => (picking[s.sectionId] = v)}
							onchange={(e) => {
								const v = (e.currentTarget as HTMLInputElement).value.trim();
								const c = v.startsWith('deck: ') ? candidates.find((x) => x.kind === 'deck' && x.target === v.slice(6)) : candidates.find((x) => x.kind === 'tag' && x.target === v);
								if (c) add(s, `${c.kind}:${c.target}`);
							}}
						/>
					</div>
				</div>
			{:else}
				{#if !loading}<p class="small muted" style="padding: 0.75rem">{onlyUnmatched ? 'Every chapter has a match.' : 'This book has no chapters yet.'}</p>{/if}
			{/each}
			{#if others.length}
				<div class="map-row">
					<div class="sec"><div class="strong">Other pages</div><div class="tiny muted">from an earlier version of the chapters</div></div>
					<div class="targets">
						{#each others as m (key(m) + m.target)}
							<span class="target"><span class="truncate">{label(m)} · pp. {m.pageFrom}–{m.pageTo}</span><button type="button" aria-label="Remove" onclick={() => remove(m)}><Icon name="x" size={11} stroke={2.5} /></button></span>
						{/each}
					</div>
				</div>
			{/if}
		</div>

		<div class="setting" style="border: 0; padding: 0">
			<div>
				<div class="setting-title">Keep unread chapters suspended</div>
				<div class="setting-hint">Never-studied cards of chapters you haven’t marked done stay suspended until you finish them. Off: only unsuspend.</div>
			</div>
			<input type="checkbox" class="switch" aria-label="Keep unread chapters suspended" bind:checked={suspendUnread} />
		</div>

		{#if preview}
			<div class="notice">
				<Icon name="info" size={16} />
				<div>
					{preview.matched} of {preview.cards} cards in this deck match a chapter. Saving will
					<strong>unsuspend {preview.willUnsuspend}</strong> (chapters you’ve finished){suspendUnread ? ' and ' : ''}{#if suspendUnread}<strong>suspend {preview.willSuspend}</strong> never-studied cards of unfinished chapters{/if}.
				</div>
			</div>
		{/if}
		{#if error}<div class="error-box" role="alert"><Icon name="alert" size={16} />{error}</div>{/if}
	</div>
	{#snippet footer()}
		<span class="small muted" style="margin-right: auto">Suspensions also reach Anki on the next sync.</span>
		<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" disabled={saving || !deck} onclick={save}>{saving ? 'Saving…' : link ? 'Save link' : 'Link deck'}</button>
	{/snippet}
</Modal>

<style>
	.static {
		min-height: var(--control-h);
		display: flex;
		align-items: center;
		color: var(--text-2);
	}
	.map-list {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		max-height: 46vh;
		overflow-y: auto;
	}
	.map-row {
		display: grid;
		grid-template-columns: minmax(10rem, 16rem) minmax(0, 1fr);
		gap: 0.75rem;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--border);
		align-items: center;
	}
	.map-row:last-child {
		border-bottom: 0;
	}
	.map-row.none .sec .strong {
		color: var(--text-3);
	}
	.sec {
		min-width: 0;
		font-size: 0.8125rem;
	}
	.targets {
		display: flex;
		flex-wrap: wrap;
		gap: 0.3125rem;
		align-items: center;
		min-width: 0;
	}
	.target {
		display: inline-flex;
		align-items: center;
		gap: 0.3125rem;
		max-width: 100%;
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.125rem 0.25rem 0.125rem 0.5rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent-text);
	}
	.target button {
		border: 0;
		background: transparent;
		color: inherit;
		display: inline-flex;
		padding: 2px;
		cursor: pointer;
		border-radius: 50%;
	}
	.pick {
		width: auto;
		max-width: 14rem;
	}
	@media (max-width: 640px) {
		.map-row {
			grid-template-columns: 1fr;
		}
	}
</style>
