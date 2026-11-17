<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import { api } from '#lib/client/api.js';
	import { unlockAudio } from '#lib/client/chime.js';
	import { toastError } from '#lib/client/toast.svelte.js';
	import { durationLabel } from '#lib/dates.js';
	import { sessionFocusFrom, type FocusPrefs, type SessionFocus } from '#lib/focus.js';
	import { ITEM_ICON, type PlanItem } from '#lib/session.js';
	import Icon from './Icon.svelte';

	// Plan a session: how long, what to work on (suggested, or picked by hand
	// from decks, categories, chapters, mistakes and your own tasks), and the
	// focus timer. Starting goes straight to the first item.

	interface Options {
		secondsPerCard: { review: number; fresh: number };
		secondsPerPage: number;
		retestMinutes: number;
		repairMinutes: number;
		totals: { due: number; new: number };
		decks: { deck: string; label: string; depth: number; due: number; new: number }[];
		categories: { code: string; name: string; due: number; new: number }[];
		books: { id: string; title: string; pageCount: number; lastPage: number; sections: { id: string; title: string; level: number; pageStart: number; pageEnd: number }[] }[];
		mistakes: { id: string; state: string; summary: string; aamcCode: string | null; reason: string; retestDue: string | null; dueNow: boolean }[];
		prefs: FocusPrefs;
	}

	let { quickDeck = null }: { quickDeck?: string | null } = $props();

	let opts = $state<Options | null>(null);
	let minutes = $state<number | null>(null);
	let custom = $state('');
	let items = $state<(PlanItem & { open?: boolean })[]>([]);
	let note = $state<string | null>(null);
	let loading = $state(false);
	let starting = $state(false);
	let title = $state('');
	let scope = $state(''); // '' | 'deck:<name>' | 'aamc:<code>'
	let useTimer = $state(true);
	let focus = $state<SessionFocus>({ focusMinutes: 25, shortBreakMinutes: 5, longBreakMinutes: 15, roundsBeforeLong: 4, autoStartBreaks: true, autoStartFocus: false });
	let editTimer = $state(false);
	let adding = $state<null | 'cards' | 'reading' | 'mistakes' | 'task'>(null);

	onMount(async () => {
		try {
			opts = await api<Options>('/api/session');
			useTimer = opts.prefs.useTimer;
			focus = sessionFocusFrom(opts.prefs);
			if (quickDeck) scope = `deck:${quickDeck}`;
		} catch (err) {
			toastError(err);
		}
	});

	const presets = $derived(opts?.prefs.presets ?? [15, 25, 30, 45, 60, 90]);
	const planned = $derived(items.reduce((a, i) => a + i.minutes, 0));
	const uid = () => (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2));

	function scopeBody() {
		if (scope.startsWith('deck:')) return { deck: scope.slice(5) };
		if (scope.startsWith('aamc:')) return { aamcCode: scope.slice(5) };
		return {};
	}

	async function suggest(m = minutes) {
		if (!m || m < 5) return;
		minutes = m;
		loading = true;
		try {
			const r = await api<{ items: PlanItem[]; note: string | null }>('/api/session/build', { body: { minutes: m, ...scopeBody() } });
			items = r.items;
			note = r.note;
		} catch (err) {
			toastError(err);
		} finally {
			loading = false;
		}
	}

	function pickTime(m: number) {
		minutes = m;
		if (!items.length) void suggest(m);
	}

	// ---- adding by hand

	let cardSource = $state(''); // '' all | deck:x | aamc:x
	let cardKind = $state<'reviews' | 'new'>('reviews');
	let cardCount = $state(20);
	const sourceAvail = $derived.by(() => {
		if (!opts) return { due: 0, new: 0 };
		if (cardSource.startsWith('deck:')) {
			const d = opts.decks.find((x) => x.deck === cardSource.slice(5));
			return d ? { due: d.due, new: d.new } : { due: 0, new: 0 };
		}
		if (cardSource.startsWith('aamc:')) {
			const c = opts.categories.find((x) => x.code === cardSource.slice(5));
			return c ? { due: c.due, new: c.new } : { due: 0, new: 0 };
		}
		return opts.totals;
	});
	const sourceLabel = (s: string) =>
		s.startsWith('deck:') ? s.slice(5).split('::').join(' › ') : s.startsWith('aamc:') ? `${s.slice(5)} ${opts?.categories.find((c) => c.code === s.slice(5))?.name ?? ''}`.trim() : 'all decks';

	function addCards() {
		if (!opts) return;
		const n = Math.max(1, Math.round(cardCount) || 1);
		const per = cardKind === 'new' ? opts.secondsPerCard.fresh : opts.secondsPerCard.review;
		const secs = n * per;
		const where = sourceLabel(cardSource);
		items = [
			...items,
			{
				id: uid(),
				type: cardKind,
				title: `${cardKind === 'new' ? 'New cards' : 'Flashcard reviews'} · ${where}`,
				detail: `${n} card${n === 1 ? '' : 's'} · about ${durationLabel(secs, 'long')}`,
				why: `You picked ${cardKind === 'new' ? 'new cards' : 'due cards'} from ${where}.`,
				minutes: Math.max(1, Math.round(secs / 60)),
				count: n,
				deck: cardSource.startsWith('deck:') ? cardSource.slice(5) : null,
				aamcCode: cardSource.startsWith('aamc:') ? cardSource.slice(5) : null
			}
		];
		adding = null;
	}

	let bookId = $state('');
	let sectionId = $state('');
	let fromPage = $state(1);
	let toPage = $state(10);
	const book = $derived(opts?.books.find((b) => b.id === bookId) ?? null);
	$effect(() => {
		// Picking a chapter fills in its pages.
		const s = book?.sections.find((x) => x.id === sectionId);
		if (s) {
			fromPage = s.pageStart;
			toPage = s.pageEnd;
		}
	});
	function pickBook(id: string) {
		bookId = id;
		sectionId = '';
		const b = opts?.books.find((x) => x.id === id);
		if (b) {
			fromPage = b.lastPage;
			toPage = Math.min(b.pageCount, b.lastPage + 9);
		}
	}
	function addReading() {
		if (!opts || !book) return;
		const a = Math.max(1, Math.min(book.pageCount, Math.round(fromPage) || 1));
		const b = Math.max(a, Math.min(book.pageCount, Math.round(toPage) || a));
		const pages = b - a + 1;
		const secs = pages * opts.secondsPerPage;
		const section = book.sections.find((x) => x.id === sectionId);
		items = [
			...items,
			{
				id: uid(),
				type: 'reading',
				title: `Read: ${section ? section.title : book.title}`,
				detail: `${book.title} · pages ${a}–${b} · about ${durationLabel(secs, 'long')}`,
				why: `You picked ${section ? `the chapter “${section.title}”` : `pages ${a}–${b}`}. It’s checked off when you reach page ${b}.`,
				minutes: Math.max(1, Math.round(secs / 60)),
				documentId: book.id,
				fromPage: a,
				toPage: b
			}
		];
		adding = null;
	}

	let pickedMistakes = $state<Record<string, boolean>>({});
	function addMistakes() {
		if (!opts) return;
		const chosen = opts.mistakes.filter((m) => pickedMistakes[m.id] && !items.some((i) => i.mistakeId === m.id));
		items = [
			...items,
			...chosen.map((m) => {
				const retest = m.state === 'retest';
				const mins = retest ? opts!.retestMinutes : opts!.repairMinutes;
				return {
					id: uid(),
					type: (retest ? 'retest' : 'repair') as PlanItem['type'],
					title: `${retest ? 'Retest' : 'Fix'}: ${m.summary}`,
					detail: `${m.reason} · about ${mins} min`,
					why: retest ? 'Try a different question on the same idea to check the fix holds.' : 'Go back to the passage behind it and explain the idea in your own words.',
					minutes: mins,
					mistakeId: m.id
				};
			})
		];
		pickedMistakes = {};
		adding = null;
	}

	let taskTitle = $state('');
	let taskMinutes = $state(20);
	function addTask() {
		if (!taskTitle.trim()) return;
		const m = Math.max(1, Math.round(taskMinutes) || 1);
		items = [
			...items,
			{ id: uid(), type: 'custom', title: taskTitle.trim(), detail: `Your own task · about ${m} min`, why: 'Something you added yourself. Check it off from the session bar when it’s done.', minutes: m }
		];
		taskTitle = '';
		adding = null;
	}

	function setCount(item: (typeof items)[number], value: number) {
		if (!opts) return;
		const n = Math.max(1, Math.round(value));
		if (item.type === 'reading' && item.fromPage) {
			item.toPage = item.fromPage + n - 1;
			const secs = n * opts.secondsPerPage;
			item.minutes = Math.max(1, Math.round(secs / 60));
			item.detail = item.detail.replace(/pages? \d+–\d+/i, (s) => `${s.startsWith('P') ? 'Pages' : 'pages'} ${item.fromPage}–${item.toPage}`).replace(/about [^·]+$/, `about ${durationLabel(secs, 'long')}`);
		} else if (item.type === 'custom') {
			item.minutes = n;
			item.detail = `Your own task · about ${n} min`;
		} else {
			item.count = n;
			const secs = n * (item.type === 'new' ? opts.secondsPerCard.fresh : opts.secondsPerCard.review);
			item.minutes = Math.max(1, Math.round(secs / 60));
			item.detail = item.detail.replace(/^\d+/, String(n)).replace(/about [^·]+$/, `about ${durationLabel(secs, 'long')}`);
		}
	}

	function move(i: number, by: -1 | 1) {
		const j = i + by;
		if (j < 0 || j >= items.length) return;
		const next = [...items];
		[next[i], next[j]] = [next[j], next[i]];
		items = next;
	}

	async function start() {
		if (!items.length) return;
		unlockAudio();
		starting = true;
		try {
			const r = await api<{ id: string }>('/api/session', {
				body: {
					budgetMinutes: minutes ?? Math.max(5, planned),
					title,
					items: items.map(({ open: _o, ...rest }) => rest),
					focus: useTimer ? focus : null
				}
			});
			await invalidate('app:shell');
			await goto(`/session/${r.id}/next`);
		} catch (err) {
			toastError(err);
		} finally {
			starting = false;
		}
	}
</script>

<div class="stack builder">
	<div class="field">
		<span class="label" id="budget-label">How much time do you have?</span>
		<div class="row-tight" role="group" aria-labelledby="budget-label">
			{#each presets as m (m)}
				<button type="button" class="btn btn-sm" class:chosen={minutes === m} aria-pressed={minutes === m} onclick={() => pickTime(m)}>{m} min</button>
			{/each}
			<form
				class="row-tight"
				onsubmit={(e) => {
					e.preventDefault();
					if (Number(custom) >= 5) pickTime(Number(custom));
				}}
			>
				<label for="custom-min" class="sr-only">Other length in minutes</label>
				<input id="custom-min" class="input mono" style="width: 6rem; min-height: 36px" type="number" min="5" max="600" placeholder="Other" bind:value={custom} />
				<button class="btn btn-sm" disabled={!custom}>Set</button>
			</form>
		</div>
		<span class="hint">Change these choices in <a href="/settings/focus">Settings › Focus &amp; breaks</a>.</span>
	</div>

	<div class="field">
		<span class="label">What do you want to work on?</span>
		<div class="row-tight">
			<label for="plan-scope" class="sr-only">Keep flashcards to</label>
			<select id="plan-scope" class="select" style="width: auto; min-width: 13rem; max-width: 100%; min-height: 40px" bind:value={scope}>
				<option value="">Everything that’s due</option>
				{#if opts?.decks.length}
					<optgroup label="One deck">
						{#each opts.decks as d (d.deck)}<option value="deck:{d.deck}">{'  '.repeat(d.depth)}{d.label} ({d.due} due · {d.new} new)</option>{/each}
					</optgroup>
				{/if}
				{#if opts?.categories.length}
					<optgroup label="One AAMC category">
						{#each opts.categories as c (c.code)}<option value="aamc:{c.code}">{c.code} {c.name} ({c.due} due)</option>{/each}
					</optgroup>
				{/if}
			</select>
			<button type="button" class="btn btn-sm" disabled={loading || !minutes} onclick={() => suggest()} title={minutes ? '' : 'Pick a length first'}>
				<Icon name="sparkle" size={16} />{loading ? 'Planning…' : items.length ? 'Suggest again' : 'Suggest a plan'}
			</button>
			<span class="small muted">or add things yourself:</span>
		</div>
		<div class="row-tight add-row">
			<button type="button" class="btn btn-sm" aria-pressed={adding === 'cards'} onclick={() => (adding = adding === 'cards' ? null : 'cards')}><Icon name="cards" size={16} />Flashcards</button>
			<button type="button" class="btn btn-sm" aria-pressed={adding === 'reading'} onclick={() => (adding = adding === 'reading' ? null : 'reading')}><Icon name="book" size={16} />Reading</button>
			<button type="button" class="btn btn-sm" aria-pressed={adding === 'mistakes'} onclick={() => (adding = adding === 'mistakes' ? null : 'mistakes')}><Icon name="journal" size={16} />Mistakes</button>
			<button type="button" class="btn btn-sm" aria-pressed={adding === 'task'} onclick={() => (adding = adding === 'task' ? null : 'task')}><Icon name="plus" size={16} />Your own task</button>
		</div>
	</div>

	{#if adding && opts}
		<div class="add-panel">
			{#if adding === 'cards'}
				<div class="form-grid">
					<div class="field">
						<label for="add-src">From</label>
						<select id="add-src" class="select" bind:value={cardSource}>
							<option value="">All decks ({opts.totals.due} due · {opts.totals.new} new)</option>
							{#if opts.decks.length}
								<optgroup label="Anki decks">
									{#each opts.decks as d (d.deck)}<option value="deck:{d.deck}">{'  '.repeat(d.depth)}{d.label} ({d.due} due · {d.new} new)</option>{/each}
								</optgroup>
							{/if}
							{#if opts.categories.length}
								<optgroup label="AAMC categories">
									{#each opts.categories as c (c.code)}<option value="aamc:{c.code}">{c.code} {c.name} ({c.due} due · {c.new} new)</option>{/each}
								</optgroup>
							{/if}
						</select>
					</div>
					<div class="field">
						<span class="label" id="add-kind">Which cards</span>
						<div class="segmented" role="radiogroup" aria-labelledby="add-kind">
							<button type="button" role="radio" aria-checked={cardKind === 'reviews'} onclick={() => (cardKind = 'reviews')}>Due ({sourceAvail.due})</button>
							<button type="button" role="radio" aria-checked={cardKind === 'new'} onclick={() => (cardKind = 'new')}>New ({sourceAvail.new})</button>
						</div>
					</div>
					<div class="field">
						<label for="add-count">How many</label>
						<input id="add-count" class="input mono" type="number" min="1" max="9999" bind:value={cardCount} />
					</div>
				</div>
				<div class="row-tight"><button type="button" class="btn btn-primary btn-sm" onclick={addCards}>Add to plan</button><button type="button" class="btn btn-sm btn-ghost" onclick={() => (adding = null)}>Cancel</button></div>
			{:else if adding === 'reading'}
				{#if opts.books.length}
					<div class="form-grid">
						<div class="field">
							<label for="add-book">Book</label>
							<select id="add-book" class="select" value={bookId} onchange={(e) => pickBook((e.currentTarget as HTMLSelectElement).value)}>
								<option value="" disabled>Pick a book</option>
								{#each opts.books as b (b.id)}<option value={b.id}>{b.title}</option>{/each}
							</select>
						</div>
						{#if book && book.sections.length}
							<div class="field">
								<label for="add-section">Chapter <span class="muted" style="font-weight: 400">(optional)</span></label>
								<select id="add-section" class="select" bind:value={sectionId}>
									<option value="">Pick pages yourself</option>
									{#each book.sections as s (s.id)}<option value={s.id}>{'  '.repeat(s.level)}{s.title} (p. {s.pageStart}–{s.pageEnd})</option>{/each}
								</select>
							</div>
						{/if}
						{#if book}
							<div class="field">
								<span class="label">Pages</span>
								<div class="row-tight">
									<label for="add-from" class="sr-only">From page</label>
									<input id="add-from" class="input mono" style="width: 5.5rem" type="number" min="1" max={book.pageCount} bind:value={fromPage} />
									<span class="muted">to</span>
									<label for="add-to" class="sr-only">To page</label>
									<input id="add-to" class="input mono" style="width: 5.5rem" type="number" min="1" max={book.pageCount} bind:value={toPage} />
								</div>
							</div>
						{/if}
					</div>
					<div class="row-tight"><button type="button" class="btn btn-primary btn-sm" disabled={!book} onclick={addReading}>Add to plan</button><button type="button" class="btn btn-sm btn-ghost" onclick={() => (adding = null)}>Cancel</button></div>
				{:else}
					<p class="small muted">No books yet. <a href="/library">Import one in the Library</a>.</p>
				{/if}
			{:else if adding === 'mistakes'}
				{#if opts.mistakes.length}
					<div class="mistake-pick">
						{#each opts.mistakes as m (m.id)}
							<label class="checkbox" style="min-height: 36px; align-items: flex-start">
								<input type="checkbox" checked={!!pickedMistakes[m.id]} onchange={(e) => (pickedMistakes = { ...pickedMistakes, [m.id]: (e.currentTarget as HTMLInputElement).checked })} />
								<span class="small"><strong>{m.state === 'retest' ? 'Retest' : 'Fix'}:</strong> {m.summary} <span class="muted">· {m.reason}{m.state === 'retest' && !m.dueNow ? ` · retest on ${m.retestDue}` : ''}</span></span>
							</label>
						{/each}
					</div>
					<div class="row-tight"><button type="button" class="btn btn-primary btn-sm" disabled={!Object.values(pickedMistakes).some(Boolean)} onclick={addMistakes}>Add to plan</button><button type="button" class="btn btn-sm btn-ghost" onclick={() => (adding = null)}>Cancel</button></div>
				{:else}
					<p class="small muted">Nothing open in your mistake journal.</p>
				{/if}
			{:else}
				<div class="form-grid">
					<div class="field" style="grid-column: span 2">
						<label for="task-title">Task</label>
						<input id="task-title" class="input" placeholder="e.g. UWorld block, CARS passage, Khan Academy video" bind:value={taskTitle} onkeydown={(e) => e.key === 'Enter' && (e.preventDefault(), addTask())} />
					</div>
					<div class="field">
						<label for="task-min">Minutes</label>
						<input id="task-min" class="input mono" type="number" min="1" max="600" bind:value={taskMinutes} />
					</div>
				</div>
				<div class="row-tight"><button type="button" class="btn btn-primary btn-sm" disabled={!taskTitle.trim()} onclick={addTask}>Add to plan</button><button type="button" class="btn btn-sm btn-ghost" onclick={() => (adding = null)}>Cancel</button></div>
			{/if}
		</div>
	{/if}

	{#if items.length}
		<ul class="plan">
			{#each items as item, i (item.id)}
				<li>
					<span class="plan-icon"><Icon name={ITEM_ICON[item.type]} size={18} /></span>
					<div class="plan-body">
						<div class="list-title">{item.title}</div>
						<div class="list-sub">{item.detail}</div>
						{#if item.open}<p class="why">{item.why}</p>{/if}
						<div class="row-tight" style="margin-top: 0.375rem">
							<button type="button" class="btn btn-ghost btn-sm" aria-expanded={!!item.open} onclick={() => (item.open = !item.open)}>{item.open ? 'Hide reason' : 'Why this?'}</button>
							{#if item.type === 'reviews' || item.type === 'new'}
								<label class="small muted" for="count-{item.id}">Cards</label>
								<input id="count-{item.id}" class="input mono" style="width: 5.5rem; min-height: 36px" type="number" min="1" value={item.count} onchange={(e) => setCount(item, Number((e.currentTarget as HTMLInputElement).value))} />
							{:else if item.type === 'reading' && item.fromPage && item.toPage}
								<label class="small muted" for="count-{item.id}">Pages</label>
								<input id="count-{item.id}" class="input mono" style="width: 5.5rem; min-height: 36px" type="number" min="1" value={item.toPage - item.fromPage + 1} onchange={(e) => setCount(item, Number((e.currentTarget as HTMLInputElement).value))} />
							{:else if item.type === 'custom'}
								<label class="small muted" for="count-{item.id}">Minutes</label>
								<input id="count-{item.id}" class="input mono" style="width: 5.5rem; min-height: 36px" type="number" min="1" value={item.minutes} onchange={(e) => setCount(item, Number((e.currentTarget as HTMLInputElement).value))} />
							{/if}
						</div>
					</div>
					<span class="mono small nowrap">{item.minutes} min</span>
					<div class="reorder">
						<button type="button" class="icon-btn plain" aria-label="Move up: {item.title}" disabled={i === 0} onclick={() => move(i, -1)}><Icon name="chevron-up" size={16} /></button>
						<button type="button" class="icon-btn plain" aria-label="Move down: {item.title}" disabled={i === items.length - 1} onclick={() => move(i, 1)}><Icon name="chevron-down" size={16} /></button>
					</div>
					<button type="button" class="icon-btn plain" aria-label="Remove {item.title}" onclick={() => (items = items.filter((x) => x.id !== item.id))}><Icon name="x" size={18} /></button>
				</li>
			{/each}
		</ul>
	{/if}
	{#if note}<div class="notice"><Icon name="info" size={18} />{note}</div>{/if}

	{#if items.length}
		<div class="timer-box">
			<label class="checkbox" style="min-height: 36px"><input type="checkbox" bind:checked={useTimer} />Use the focus timer (Pomodoro)</label>
			{#if useTimer}
				<p class="small muted">
					{focus.focusMinutes} min focus, then a {focus.shortBreakMinutes} min break; a {focus.longBreakMinutes} min break after every {focus.roundsBeforeLong} rounds.
					<button type="button" class="link-btn" onclick={() => (editTimer = !editTimer)}>{editTimer ? 'Done' : 'Change for this session'}</button>
				</p>
				{#if editTimer}
					<div class="form-grid timer-grid">
						<div class="field"><label for="f-focus">Focus (min)</label><input id="f-focus" class="input mono" type="number" min="5" max="180" bind:value={focus.focusMinutes} /></div>
						<div class="field"><label for="f-short">Break (min)</label><input id="f-short" class="input mono" type="number" min="1" max="60" bind:value={focus.shortBreakMinutes} /></div>
						<div class="field"><label for="f-long">Long break (min)</label><input id="f-long" class="input mono" type="number" min="1" max="90" bind:value={focus.longBreakMinutes} /></div>
						<div class="field"><label for="f-rounds">Rounds before a long break</label><input id="f-rounds" class="input mono" type="number" min="1" max="12" bind:value={focus.roundsBeforeLong} /></div>
					</div>
					<label class="checkbox" style="min-height: 36px"><input type="checkbox" bind:checked={focus.autoStartBreaks} />Start breaks by themselves</label>
					<label class="checkbox" style="min-height: 36px"><input type="checkbox" bind:checked={focus.autoStartFocus} />Start the next round by itself after a break</label>
				{/if}
			{/if}
		</div>
		<div class="field" style="max-width: 22rem">
			<label for="plan-title">Name <span class="muted" style="font-weight: 400">(optional)</span></label>
			<input id="plan-title" class="input" placeholder="e.g. Biochem morning" bind:value={title} maxlength="80" />
		</div>
		<div class="row" style="justify-content: space-between">
			<span class="small muted">About <span class="mono strong" style="color: var(--text)">{planned}</span>{minutes ? ` of ${minutes}` : ''} minutes planned</span>
			<button type="button" class="btn btn-primary" disabled={starting} onclick={start}>
				<Icon name="play" size={18} />{starting ? 'Starting…' : 'Start session'}
			</button>
		</div>
	{/if}
</div>

<style>
	.chosen {
		background: var(--ink);
		border-color: var(--ink);
		color: var(--on-ink);
	}
	.chosen:hover {
		background: var(--ink-hover);
		color: var(--on-ink);
	}
	.add-row [aria-pressed='true'] {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent-text);
	}
	.add-panel {
		background: var(--surface-2);
		border-radius: var(--radius);
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
	}
	.mistake-pick {
		display: flex;
		flex-direction: column;
		max-height: 16rem;
		overflow-y: auto;
	}
	.plan {
		list-style: none;
		padding: 0;
		margin: 0;
		display: flex;
		flex-direction: column;
	}
	.plan li {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.875rem 0;
		border-bottom: 1px solid var(--border);
	}
	.plan li:last-child {
		border-bottom: 0;
	}
	.plan-icon {
		width: 2rem;
		height: 2rem;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent-text);
		display: flex;
		align-items: center;
		justify-content: center;
		flex: none;
	}
	.plan-body {
		flex: 1 1 auto;
		min-width: 0;
	}
	.reorder {
		display: flex;
		flex-direction: column;
	}
	.reorder .icon-btn {
		width: 28px;
		height: 22px;
	}
	.why {
		margin-top: 0.5rem;
		font-size: 0.875rem;
		color: var(--text-2);
		background: var(--surface-2);
		border-radius: var(--radius);
		padding: 0.625rem 0.75rem;
	}
	.timer-box {
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.75rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.timer-grid {
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		margin-top: 0.25rem;
	}
	.link-btn {
		border: 0;
		background: none;
		padding: 0;
		color: var(--accent-text);
		font-weight: 600;
		cursor: pointer;
		text-decoration: underline;
	}
</style>
