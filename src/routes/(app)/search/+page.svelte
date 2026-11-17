<script lang="ts">
	import { goto } from '$app/navigation';
	import Icon from '#lib/components/Icon.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let q = $derived(data.q);

	const kinds = [
		{ v: null, l: 'Everything' },
		{ v: 'page', l: 'Books' },
		{ v: 'annotation', l: 'Notes' },
		{ v: 'card', l: 'Cards' }
	];
	const icon: Record<string, string> = { page: 'book', annotation: 'note', card: 'cards' };

	function href(kind: string | null, mode: string = data.mode) {
		const p = new URLSearchParams();
		if (data.q) p.set('q', data.q);
		if (kind) p.set('kind', kind);
		if (mode === 'meaning') p.set('mode', 'meaning');
		return `/search?${p.toString()}`;
	}
</script>

<svelte:head><title>{data.q ? `${data.q} · ` : ''}Search · Medicus Vitae</title></svelte:head>

<div class="page">
	<header class="stack-sm">
		<h1>Search</h1>
		<form
			class="row"
			role="search"
			onsubmit={(e) => {
				e.preventDefault();
				void goto(`/search?q=${encodeURIComponent(q.trim())}${data.kind ? `&kind=${data.kind}` : ''}${data.mode === 'meaning' ? '&mode=meaning' : ''}`);
			}}
		>
			<label for="q" class="sr-only">Search</label>
			<!-- svelte-ignore a11y_autofocus -->
			<input id="q" class="input" style="flex: 1 1 20rem; font-size: 1.0625rem" bind:value={q} placeholder="Search your books, notes and cards" autofocus />
			<button class="btn btn-primary"><Icon name="search" size={18} />Search</button>
		</form>
		<p class="hint">
			{#if data.mode === 'meaning'}
				Meaning search finds passages about the same idea even when the words differ. It runs on this device; nothing is sent anywhere.
			{:else}
				Words are matched with their endings (enzyme finds enzymes). Use "quotes" for an exact phrase.
			{/if}
		</p>
	</header>

	{#if data.q}
		<div class="row" style="justify-content: space-between">
			<div class="row-tight">
				<div class="segmented" role="tablist" aria-label="Search by">
					<a href={href(data.kind, 'keyword')} aria-current={data.mode === 'keyword' ? 'page' : undefined}>Keywords</a>
					<a href={href(data.kind, 'meaning')} aria-current={data.mode === 'meaning' ? 'page' : undefined}>Meaning</a>
				</div>
				<div class="segmented" role="tablist" aria-label="Result type">
					{#each kinds as k (k.l)}<a href={href(k.v)} aria-current={data.kind === k.v ? 'page' : undefined}>{k.l}</a>{/each}
				</div>
			</div>
			<span class="small muted">{data.total} result{data.total === 1 ? '' : 's'}</span>
		</div>
		{#if data.mode === 'meaning' && !data.usedMeaning}
			<div class="notice small"><Icon name="info" size={16} />The meaning index isn’t ready yet (it builds in the background), so these are keyword matches.</div>
		{/if}
		{#if data.hits.length}
			<div class="card" style="padding: 0.25rem 1.25rem">
				<div class="list">
					{#each data.hits as h (h.kind + h.refId)}
						<a class="list-row hit" href={h.href}>
							<span class="hit-icon"><Icon name={icon[h.kind]} size={18} /></span>
							<div style="flex: 1 1 auto; min-width: 0">
								<div class="list-title truncate">{h.title}</div>
								<div class="small snippet">{#each h.segments as s, i (i)}{#if s.hit}<mark>{s.text}</mark>{:else}{s.text}{/if}{/each}</div>
							</div>
						</a>
					{/each}
				</div>
			</div>
		{:else}
			<div class="card empty"><Icon name="search" size={28} /><h2>No matches</h2><p>Try fewer or different words.</p></div>
		{/if}
	{/if}
</div>

<style>
	.hit {
		text-decoration: none;
		color: inherit;
		align-items: flex-start;
		flex-wrap: nowrap;
	}
	.hit:hover .list-title {
		color: var(--accent-text);
	}
	.hit-icon {
		width: 2rem;
		height: 2rem;
		flex: none;
		border-radius: 999px;
		background: var(--surface-2);
		display: flex;
		align-items: center;
		justify-content: center;
		color: var(--text-2);
	}
	.snippet {
		color: var(--text-2);
		margin-top: 2px;
	}
	.snippet :global(mark) {
		background: var(--hl-yellow);
		color: var(--text);
		border-radius: 3px;
		padding: 0 2px;
	}
</style>
