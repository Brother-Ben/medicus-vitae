<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { onDestroy, onMount } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { api } from '#lib/client/api.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import { relativeTime } from '#lib/dates.js';
	import type { AnkiConnectConfig, AnkiStatus } from '#lib/server/anki/connect.js';
	import type { SyncReport } from '#lib/server/anki/sync.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const seed = () => ({ config: { ...data.config }, decks: data.decks, state: data.state });
	let cfg = $state<AnkiConnectConfig>(seed().config);
	let decks = $state(seed().decks);
	let sync = $state(seed().state);
	let status = $state<AnkiStatus | null>(null);
	let checking = $state(false);
	let picked = $state<Record<string, boolean>>(Object.fromEntries(seed().decks.filter((d) => d.enabled).map((d) => [d.deck, true])));
	let poll: ReturnType<typeof setInterval> | null = null;

	const topDecks = $derived((status?.decks ?? decks.map((d) => d.deck)).filter((d) => !d.includes('::')));
	const subCount = (root: string) => (status?.decks ?? []).filter((d) => d.startsWith(root + '::')).length;
	const last = $derived(sync.last as SyncReport | null);

	async function check() {
		checking = true;
		try {
			status = (await api<{ status: AnkiStatus }>('/api/anki/sync', { body: { action: 'check' } })).status;
		} catch (err) {
			toastError(err);
		} finally {
			checking = false;
		}
	}

	async function saveConfig(patch: Partial<AnkiConnectConfig>) {
		cfg = { ...cfg, ...patch };
		try {
			cfg = (await api<{ config: AnkiConnectConfig }>('/api/anki/sync', { body: { action: 'config', config: patch } })).config;
		} catch (err) {
			toastError(err);
		}
	}

	async function saveDecks() {
		try {
			decks = (await api<{ decks: typeof decks }>('/api/anki/sync', { body: { action: 'decks', decks: Object.keys(picked).filter((k) => picked[k]) } })).decks;
			toast('Decks saved');
		} catch (err) {
			toastError(err);
		}
	}

	async function refresh() {
		const r = await api<{ config: AnkiConnectConfig; decks: typeof decks; state: typeof sync }>('/api/anki/sync');
		sync = r.state;
		decks = r.decks;
		if (!sync.running && poll) {
			clearInterval(poll);
			poll = null;
			const rep = sync.last as SyncReport | null;
			if (rep?.ok) toast('Synced with Anki');
			await invalidateAll();
		}
	}

	async function syncNow() {
		if (Object.keys(picked).some((k) => picked[k]) && !decks.some((d) => d.enabled)) await saveDecks();
		try {
			await api('/api/anki/sync', { body: { action: 'sync' } });
			sync = { ...sync, running: true, step: 'Starting' };
			poll ??= setInterval(() => void refresh().catch(() => {}), 1000);
		} catch (err) {
			toastError(err);
		}
	}

	onMount(() => {
		void check();
		if (sync.running) poll = setInterval(() => void refresh().catch(() => {}), 1000);
	});
	onDestroy(() => poll && clearInterval(poll));
</script>

<svelte:head><title>Anki sync · Settings · Medicus Vitae</title></svelte:head>

<section class="card stack" aria-labelledby="conn-h">
	<div class="row" style="justify-content: space-between">
		<div>
			<h2 id="conn-h">Sync with Anki</h2>
			<p class="small muted" style="margin-top: 0.25rem">Keep your Anki decks, reviews and new cards in step, on this computer and on your phone.</p>
		</div>
		<button type="button" class="btn btn-sm" disabled={checking} onclick={check}><Icon name="refresh" size={16} />{checking ? 'Checking…' : 'Check connection'}</button>
	</div>
	{#if status}
		<div class={status.reachable ? 'notice' : 'warning'} role="status">
			<Icon name={status.reachable ? 'check' : 'alert'} size={18} />
			<span>{status.reachable ? `Connected to Anki (AnkiConnect ${status.version}). ${status.decks.length} deck${status.decks.length === 1 ? '' : 's'} found.` : status.message}</span>
		</div>
	{/if}

	<div class="flow" aria-label="How it connects">
		<span class="node"><Icon name="wifi" size={16} />Anki on your phone</span>
		<span class="arrow">⇄</span>
		<span class="node">AnkiWeb</span>
		<span class="arrow">⇄</span>
		<span class="node">Anki on this computer</span>
		<span class="arrow">⇄</span>
		<span class="node strong">Medicus</span>
	</div>

	<details class="setup" open={!status?.reachable}>
		<summary class="strong">Set it up (once)</summary>
		<ol class="steps">
			<li><strong>Open Anki on this computer.</strong> It’s already installed (Anki Launcher). Anki needs to be open while syncing; minimized is fine.</li>
			<li>
				<strong>Add the AnkiConnect add-on.</strong> In Anki: <em>Tools › Add-ons › Get Add-ons…</em>, paste this code, press OK, then close and reopen Anki.
				<div class="row-tight" style="margin-top: 0.375rem">
					<code class="code">2055492159</code>
					<button type="button" class="btn btn-sm btn-ghost" onclick={() => navigator.clipboard?.writeText('2055492159').then(() => toast('Code copied'))}>Copy</button>
				</div>
			</li>
			<li>
				<strong>Sign in to AnkiWeb in Anki desktop</strong> with the same account as your phone: click <em>Sync</em> at the top of Anki. If Anki asks which side to keep, choose <em>Download from AnkiWeb</em> so this computer gets your phone’s cards.
			</li>
			<li><strong>Come back here</strong>, press <em>Check connection</em>, pick your decks below, and press <em>Sync now</em>. If Anki asks whether to allow this app, choose <em>Yes</em>.</li>
		</ol>
	</details>
</section>

<section class="card stack" aria-labelledby="decks-h">
	<div>
		<h2 id="decks-h">Decks to sync</h2>
		<p class="small muted" style="margin-top: 0.25rem">Each deck comes with its subdecks. The first sync reads the whole deck in, with its review history; after that only what changed.</p>
	</div>
	{#if topDecks.length}
		<div class="deck-pick">
			{#each topDecks as d (d)}
				<label class="checkbox" style="min-height: 38px">
					<input type="checkbox" checked={!!picked[d]} onchange={(e) => (picked = { ...picked, [d]: (e.currentTarget as HTMLInputElement).checked })} />
					<span>{d}{#if subCount(d)} <span class="tiny muted">· {subCount(d)} subdeck{subCount(d) === 1 ? '' : 's'}</span>{/if}{#if d === cfg.pushDeck} <span class="tiny muted">· cards made here go here</span>{/if}</span>
				</label>
			{/each}
		</div>
		<div><button type="button" class="btn btn-sm" onclick={saveDecks}>Save decks</button></div>
	{:else}
		<p class="small muted">Connect to Anki to see your decks.</p>
	{/if}
</section>

<section class="card stack" aria-labelledby="opt-h">
	<h2 id="opt-h">Options</h2>
	<label class="checkbox"><input type="checkbox" checked={cfg.ankiWeb} onchange={(e) => saveConfig({ ankiWeb: (e.currentTarget as HTMLInputElement).checked })} />Include my phone: have Anki sync with AnkiWeb before and after</label>
	<label class="checkbox"><input type="checkbox" checked={cfg.pushOwnCards} onchange={(e) => saveConfig({ pushOwnCards: (e.currentTarget as HTMLInputElement).checked })} />Send cards I make here to Anki</label>
	{#if cfg.pushOwnCards}
		<div class="field" style="max-width: 22rem; margin-top: -0.5rem">
			<label for="push-deck">Into the deck</label>
			<input id="push-deck" class="input" value={cfg.pushDeck} onchange={(e) => saveConfig({ pushDeck: (e.currentTarget as HTMLInputElement).value })} />
			<span class="hint">Cards from a book go into a subdeck named after the book, like “{cfg.pushDeck}::Biology 2e”.</span>
		</div>
	{/if}
	<div class="row-tight">
		<label class="checkbox"><input type="checkbox" checked={cfg.auto} onchange={(e) => saveConfig({ auto: (e.currentTarget as HTMLInputElement).checked })} />Sync by itself every</label>
		<input class="input mono" style="width: 5rem; min-height: 36px" type="number" min="2" max="240" value={cfg.autoMinutes} aria-label="Minutes between syncs" onchange={(e) => saveConfig({ autoMinutes: Number((e.currentTarget as HTMLInputElement).value) })} />
		<span class="small muted">minutes while Anki is open</span>
	</div>
	<details>
		<summary class="small strong">Advanced</summary>
		<div class="form-grid" style="margin-top: 0.75rem">
			<div class="field">
				<label for="ac-url">AnkiConnect address</label>
				<input id="ac-url" class="input mono" value={cfg.url} onchange={(e) => saveConfig({ url: (e.currentTarget as HTMLInputElement).value })} />
			</div>
			<div class="field">
				<label for="ac-key">API key <span class="muted" style="font-weight: 400">(only if you set one in AnkiConnect)</span></label>
				<input id="ac-key" class="input mono" type="password" autocomplete="off" value={cfg.key ?? ''} onchange={(e) => saveConfig({ key: (e.currentTarget as HTMLInputElement).value || null })} />
			</div>
		</div>
	</details>
</section>

<section class="card stack" aria-labelledby="run-h">
	<div class="row" style="justify-content: space-between">
		<h2 id="run-h">Sync</h2>
		<button type="button" class="btn btn-primary" disabled={sync.running || !status?.reachable} onclick={syncNow}><Icon name="sync" size={18} />{sync.running ? 'Syncing…' : 'Sync now'}</button>
	</div>
	{#if sync.running}
		<div class="notice" role="status"><Icon name="refresh" size={18} /><span>{sync.step || 'Working'}…</span></div>
	{/if}
	{#if last}
		<div class="report">
			<div class="row-tight">
				<span class="pill" class:pill-accent={last.ok} class:pill-warn={!last.ok}>{last.ok ? 'Last sync worked' : 'Last sync stopped'}</span>
				<span class="small muted">{relativeTime(last.finishedAt ?? last.startedAt)}{last.ankiWeb === 'synced' ? ' · phone included (AnkiWeb)' : last.ankiWeb === 'failed' ? ' · AnkiWeb didn’t sync' : ''}</span>
			</div>
			{#if last.error}<div class="error-box"><Icon name="alert" size={18} />{last.error}</div>{/if}
			{#if last.ok}
				<ul class="nums small">
					<li><span class="mono strong">{last.reviewsPulled}</span> reviews from Anki</li>
					<li><span class="mono strong">{last.reviewsPushed}</span> reviews sent to Anki</li>
					<li><span class="mono strong">{last.notesAdded}</span> new cards from Anki{last.notesUpdated ? `, ${last.notesUpdated} updated` : ''}</li>
					<li><span class="mono strong">{last.cardsPushed}</span> cards sent to Anki{last.editsPushed ? `, ${last.editsPushed} edits` : ''}</li>
					<li><span class="mono strong">{last.dueDatesSet}</span> due dates matched</li>
					{#if last.suspensionsPushed}<li><span class="mono strong">{last.suspensionsPushed}</span> suspends and unsuspends sent to Anki</li>{/if}
					{#if last.removed}<li><span class="mono strong">{last.removed}</span> removed (deleted in Anki)</li>{/if}
				</ul>
				{#if last.decksRead.length}<p class="tiny muted">Read in fully: {last.decksRead.join(', ')}</p>{/if}
			{/if}
			{#each last.warnings as w, i (i)}<div class="warning"><Icon name="alert" size={16} />{w}</div>{/each}
		</div>
	{:else}
		<p class="small muted">Not synced yet.</p>
	{/if}
</section>

<section class="card stack-sm" aria-labelledby="how-h">
	<h2 id="how-h">How it works</h2>
	<ul class="small how">
		<li>Reviews from both sides are kept. Medicus schedules each card from its whole history (FSRS); cards you study here get the same due date in Anki, so your phone shows them when they’re due.</li>
		<li>New cards and edits you make in Anki or on your phone come here. Cards you make here go to Anki (and to your phone through AnkiWeb).</li>
		<li>A card deleted in Anki is deleted here too. Deleting a card here doesn’t delete it in Anki, so nothing on your phone disappears by surprise.</li>
		<li>If the same Anki card was edited both here and in Anki, your edit here wins and is sent to Anki.</li>
		<li>“Set due date” used on your phone is replaced by this app’s schedule at the next sync if you review that card here; use Flashcards › Set due date here instead.</li>
	</ul>
</section>

<style>
	.flow {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.8125rem;
	}
	.node {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.625rem;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text-2);
	}
	.node.strong {
		background: var(--accent-soft);
		color: var(--accent-text);
	}
	.arrow {
		color: var(--text-3);
	}
	.setup summary,
	details summary {
		cursor: pointer;
	}
	.steps {
		margin: 0.75rem 0 0;
		padding-left: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		font-size: 0.9rem;
	}
	.code {
		font-family: var(--font-mono);
		font-size: 1rem;
		font-weight: 700;
		padding: 0.25rem 0.625rem;
		border-radius: 6px;
		background: var(--surface-2);
		user-select: all;
	}
	.deck-pick {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr));
		gap: 0 1rem;
	}
	.report {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}
	.nums {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.375rem 1rem;
	}
	.how {
		margin: 0.25rem 0 0;
		padding-left: 1.125rem;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
		color: var(--text-2);
	}
</style>
