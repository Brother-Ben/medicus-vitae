<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Logo from '#lib/components/Logo.svelte';
	import { api } from '#lib/client/api.js';

	// Where the "Send to Medicus" bookmark lands. The captured page travels in
	// this address's #fragment, which browsers never send to any server. It's kept
	// in this browser until the import is done (through a sign-in if needed).

	const PENDING = 'medicus-cars-capture';

	interface Result {
		id: string;
		created: boolean;
		title: string;
		questions: number;
		answers: number;
		explanations: number;
		method: string;
		warnings: string[];
	}

	let phase = $state<'reading' | 'importing' | 'done' | 'error' | 'empty'>('reading');
	let result = $state<Result | null>(null);
	let error = $state('');
	let from = $state('');
	// Bookmarks from 0.7.0 copied only the page's main part (questions in a side panel were missed).
	let oldBookmark = $state(false);
	// What the bookmark sent, kept (not as state: it can be megabytes) so it can be saved for a bug report.
	let captured: string | null = null;
	let canSave = $state(false);

	function saveCapture() {
		if (!captured) return;
		const url = URL.createObjectURL(new Blob([captured], { type: 'application/json' }));
		const a = document.createElement('a');
		a.href = url;
		a.download = 'cars-page-capture.json';
		a.click();
		setTimeout(() => URL.revokeObjectURL(url), 2000);
	}

	function b64urlToBytes(s: string): Uint8Array {
		const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
		const bin = atob(b64);
		const out = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
		return out;
	}

	async function decode(hash: string): Promise<string> {
		if (hash.startsWith('gz.')) {
			const bytes = b64urlToBytes(hash.slice(3));
			const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
			return await new Response(stream).text();
		}
		if (hash.startsWith('js.')) return decodeURIComponent(hash.slice(3));
		throw new Error('That link doesn’t hold a page from the bookmark.');
	}

	onMount(async () => {
		let raw: string | null = null;
		try {
			const hash = location.hash.slice(1);
			if (hash) {
				raw = await decode(hash);
				try {
					localStorage.setItem(PENDING, raw);
				} catch {
					// Too big for storage: carry on without the safety copy.
				}
				history.replaceState(null, '', location.pathname);
			} else {
				raw = localStorage.getItem(PENDING);
			}
		} catch (err) {
			phase = 'error';
			error = err instanceof Error ? err.message : String(err);
			return;
		}
		if (!raw) {
			phase = 'empty';
			return;
		}
		captured = raw;
		canSave = true;
		let capture: Record<string, unknown>;
		try {
			capture = JSON.parse(raw);
		} catch {
			phase = 'error';
			error = 'The page didn’t come through in one piece. Try the bookmark again.';
			return;
		}
		try {
			from = new URL(String(capture.url ?? '')).hostname.replace(/^www\./, '');
		} catch {
			from = '';
		}
		oldBookmark = capture.v === 1;
		phase = 'importing';
		try {
			result = await api<Result>('/api/cars', { body: { action: 'import', capture } });
			phase = 'done';
			localStorage.removeItem(PENDING);
			// The Medicus tab that asked for the passage shows it without a reload.
			try {
				const ch = new BroadcastChannel('medicus-cars');
				ch.postMessage({ imported: result.id });
				ch.close();
			} catch {
				// Older browsers: that tab picks it up the next time it loads.
			}
		} catch (err) {
			// Not signed in: api() is already taking us to the sign-in page, and the copy waits here.
			phase = 'error';
			error = err instanceof Error ? err.message : String(err);
			if (!/sign in/i.test(error)) localStorage.removeItem(PENDING);
		}
	});
</script>

<svelte:head><title>Import CARS passage · Medicus Vitae</title></svelte:head>

<main class="wrap">
	<div class="card box">
		<div class="row-tight" style="margin-bottom: 0.25rem"><Logo size={22} /><span class="strong">Medicus Vitae</span></div>
		{#if phase === 'reading' || phase === 'importing'}
			<h1>Importing the passage…</h1>
			<p class="muted small">{phase === 'reading' ? 'Opening what your browser sent.' : `Reading the passage and questions${from ? ` from ${from}` : ''}. This can take a few seconds.`}</p>
			<div class="bar"><span class="indeterminate"></span></div>
		{:else if phase === 'done' && result}
			<h1>{result.created ? 'Passage imported' : 'Passage updated'}</h1>
			<p class="strong">{result.title}</p>
			<ul class="facts small">
				<li><Icon name={result.questions ? 'check' : 'x'} size={14} />{result.questions} question{result.questions === 1 ? '' : 's'}</li>
				<li><Icon name={result.answers ? 'check' : 'x'} size={14} />{result.answers ? `Answer key (${result.answers})` : 'No answer key yet'}</li>
				<li><Icon name={result.explanations ? 'check' : 'x'} size={14} />{result.explanations ? `Explanations (${result.explanations})` : 'No explanations yet'}</li>
			</ul>
			{#if oldBookmark}
				<div class="warning small"><Icon name="info" size={15} /><div>Your bookmark is from an older version that could miss questions. Delete it and drag the new one from <a href="/cards/cars">Flashcards › CARS</a>, then press it on the passage again.</div></div>
			{/if}
			{#if result.questions > 0 && result.questions < 4}
				<p class="hint">CARS passages usually have more questions. If the site shows one question at a time, go to each one and press the bookmark again: new questions are added to this passage.</p>
			{/if}
			{#if !result.answers && result.questions}
				<p class="hint">Answers show on the site after you submit. Do the passage here, then submit on the site and press the bookmark again: the answers are added and your attempt is scored.</p>
			{/if}
			{#each result.warnings as w (w)}<div class="warning small"><Icon name="info" size={15} />{w}</div>{/each}
			{#if result.method === 'extracted'}<p class="hint">Read by your AI service, since the page’s layout wasn’t one Medicus knows. Check it against the page.</p>{/if}
			<div class="row" style="margin-top: 0.5rem">
				<a class="btn btn-primary" href="/cards/cars/{result.id}"><Icon name="play" size={16} />Start the passage</a>
				<a class="btn" href="/cards/cars">All CARS passages</a>
			</div>
			{#if canSave}<button type="button" class="link-btn tiny" onclick={saveCapture}>Came in wrong? Save what the bookmark sent (a .json file of that page) to report it.</button>{/if}
		{:else if phase === 'empty'}
			<h1>Nothing to import</h1>
			<p class="muted small">Open a passage on Jack Westin and press your “Send to Medicus” bookmark there. Set it up on the CARS page.</p>
			<a class="btn" href="/cards/cars">Go to CARS</a>
		{:else}
			<h1>Couldn’t import that</h1>
			<div class="error-box small"><Icon name="alert" size={15} />{error}</div>
			{#if oldBookmark}<p class="hint">Your bookmark is from an older version. Delete it and drag the new one from Flashcards › CARS, then try again.</p>{/if}
			<div class="row" style="margin-top: 0.5rem">
				<a class="btn" href="/cards/cars#paste">Paste the passage instead</a>
				<a class="btn btn-ghost" href="/cards/cars">CARS</a>
			</div>
			{#if canSave}<button type="button" class="link-btn tiny" onclick={saveCapture}>Save what the bookmark sent (a .json file of that page) to report it.</button>{/if}
		{/if}
	</div>
</main>

<style>
	.wrap {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
	}
	.box {
		width: min(30rem, 100%);
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}
	h1 {
		font-size: 1.25rem;
	}
	.facts {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		color: var(--text-2);
	}
	.facts li {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}
	.indeterminate {
		width: 35% !important;
		animation: slide 1.2s ease-in-out infinite;
	}
	@keyframes slide {
		from {
			transform: translateX(-100%);
		}
		to {
			transform: translateX(300%);
		}
	}
</style>
