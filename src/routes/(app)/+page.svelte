<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import AiCoach from '#lib/components/AiCoach.svelte';
	import HistoryChart from '#lib/components/HistoryChart.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import LayoutEditor from '#lib/components/LayoutEditor.svelte';
	import Modal from '#lib/components/Modal.svelte';
	import SessionBuilder from '#lib/components/SessionBuilder.svelte';
	import { api } from '#lib/client/api.js';
	import { unlockAudio } from '#lib/client/chime.js';
	import { toastError } from '#lib/client/toast.svelte.js';
	import { durationLabel, shortDate, weekdayShort } from '#lib/dates.js';
	import { CATEGORY_SHORT, sectionOf } from '#lib/aamc.js';
	import { appearance, setAccountAppearance } from '#lib/client/appearance.svelte.js';
	import { DEFAULT_HOME, HOME_SECTIONS, type HomeSectionId } from '#lib/appearance.js';
	import { isRamadan } from '#lib/decor/calendar.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const ramadanGreeting = $derived(
		appearance.account.decorations === 'all' &&
			appearance.account.holidays.ramadan &&
			appearance.account.ramadanGreeting &&
			(appearance.preview === 'ramadan' || isRamadan(new Date(), appearance.account.ramadanOffset))
	);

	// Which sections show, in order: the account's choice (Settings › Menu & Today).
	const homePrefs = $derived(appearance.loaded ? appearance.account.home : data.shell.layout.home);
	const NEEDS_AI: HomeSectionId[] = ['coach', 'tutor'];
	const sections = $derived(homePrefs.filter((s) => s.visible && (!NEEDS_AI.includes(s.id) || data.ai)).map((s) => s.id));
	// The first three are the page's spine; the rest sit in a grid underneath.
	const SPINE: HomeSectionId[] = ['start', 'stats', 'workOn', 'cars'];
	const spine = $derived(sections.filter((id) => SPINE.includes(id)));
	const extras = $derived(sections.filter((id) => !SPINE.includes(id)));

	let tutorQ = $state('');
	let planOpen = $state(false);
	let customizeOpen = $state(false);

	const maxForecast = $derived(Math.max(1, ...data.forecast.days.map((d) => d.projected)));
	const weekPct = $derived(data.week.goalSeconds ? Math.min(100, Math.round((data.week.seconds / data.week.goalSeconds) * 100)) : null);
	const empty = $derived(!data.hasBooks && data.totals.total === 0);
	const forecastLabel = $derived(data.forecast.days.map((d) => `${weekdayShort(d.day)} ${d.projected}`).join(', '));
	const dueCards = $derived(data.due.counts.review + data.due.counts.learning);
	const prefs = $derived(data.shell.focusPrefs);

	// ---- Quick focus: one round of the focus timer on a deck's due cards.
	let quickDeck = $state('');
	let quickBusy = $state(false);
	async function quickFocus() {
		unlockAudio();
		quickBusy = true;
		try {
			const deck = data.queue.decks.find((d) => d.deck === quickDeck) ?? null;
			const available = deck ? deck.due + deck.new : dueCards + data.due.counts.new;
			const count = Math.max(5, Math.min(available || 20, Math.round((prefs.focusMinutes * 60) / 10)));
			const where = deck ? deck.label : 'all decks';
			const r = await api<{ id: string }>('/api/session', {
				body: {
					budgetMinutes: prefs.focusMinutes,
					title: `Focus · ${where}`,
					focus: prefs,
					items: [
						{
							id: crypto.randomUUID?.() ?? String(Math.random()).slice(2),
							type: dueCards || deck?.due ? 'reviews' : 'new',
							title: `Flashcards · ${where}`,
							detail: `Up to ${count} cards · ${prefs.focusMinutes} min`,
							why: 'A quick focus round on your cards.',
							minutes: prefs.focusMinutes,
							count,
							deck: deck?.deck ?? null
						}
					]
				}
			});
			await invalidate('app:shell');
			await goto(`/session/${r.id}/next`);
		} catch (err) {
			toastError(err);
		} finally {
			quickBusy = false;
		}
	}

	const homeMeta = Object.fromEntries(HOME_SECTIONS.map((s) => [s.id, { name: s.name, hint: s.hint }]));
	const reading = $derived(data.reading);
	const fmtClock = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;
</script>

<svelte:head><title>Today · Medicus Vitae</title></svelte:head>

<div class="page today">
	<header class="page-header">
		<div>
			<h1>{data.greeting}{data.name ? `, ${data.name}` : ''}</h1>
			<div class="subtitle">{data.calendarDate}{#if ramadanGreeting}<span class="greeting"> · Ramadan Kareem</span>{/if}</div>
		</div>
		{#if !empty}
			<div class="row-tight">
				<button type="button" class="btn btn-sm" onclick={() => (planOpen = true)}><Icon name="list" size={16} />Plan a session</button>
				<button type="button" class="icon-btn sm" aria-label="Choose what Today shows" title="Choose what Today shows" onclick={() => (customizeOpen = true)}>
					<Icon name="settings" size={16} />
				</button>
			</div>
		{/if}
	</header>

	{#if empty}
		<section class="card empty">
			<Icon name="book" size={28} />
			<h2>Import a book to get started</h2>
			<p>Read your MCAT books here, highlight passages, and turn them into flashcards that link back to the page. Or bring in your Anki decks.</p>
			<div class="row" style="justify-content: center">
				<a class="btn btn-primary" href="/library"><Icon name="upload" size={16} />Import a PDF</a>
				<a class="btn" href="/cards/import">Import from Anki</a>
				<a class="btn" href="/settings/anki">Connect Anki</a>
			</div>
		</section>
	{:else}
		{#if data.processing}
			<div class="notice"><Icon name="refresh" size={16} />{data.processing} book{data.processing === 1 ? ' is' : 's are'} still being processed. <a href="/library">See progress</a></div>
		{/if}

		{#each spine as id (id)}
			{#if id === 'start'}
				<section class="start" aria-label="Start studying">
					{#if data.activeSession}
						<a class="action primary" href="/session/{data.activeSession.id}/next">
							<Icon name="play" size={18} />
							<span class="action-text">
								<span class="action-title">Continue your session</span>
								<span class="action-sub">{data.activeSession.title || `${data.activeSession.budgetMinutes}-minute session`} · {data.activeSession.items.filter((i) => i.done).length} of {data.activeSession.items.length} done</span>
							</span>
						</a>
					{/if}
					{#if dueCards}
						<a class="action" class:primary={!data.activeSession} href="/review?only=due">
							<Icon name="cards" size={18} />
							<span class="action-text">
								<span class="action-title">Review {dueCards} due card{dueCards === 1 ? '' : 's'}</span>
								<span class="action-sub">About {durationLabel(data.due.minutes * 60, 'long')}</span>
							</span>
						</a>
					{:else if data.due.counts.new}
						<a class="action" class:primary={!data.activeSession} href="/review?only=new">
							<Icon name="plus" size={18} />
							<span class="action-text">
								<span class="action-title">Learn {data.due.counts.new} new card{data.due.counts.new === 1 ? '' : 's'}</span>
								<span class="action-sub">No reviews due</span>
							</span>
						</a>
					{:else}
						<div class="action quiet">
							<Icon name="check-circle" size={18} />
							<span class="action-text"><span class="action-title">All caught up</span><span class="action-sub">No cards due right now</span></span>
						</div>
					{/if}
					{#if reading}
						<a class="action" href="/library/{reading.id}/read?page={reading.page}">
							<Icon name="book" size={18} />
							<span class="action-text">
								<span class="action-title truncate">Resume {reading.title}</span>
								<span class="action-sub truncate">p. {reading.page}{reading.section ? ` · ${reading.section}` : ''}</span>
							</span>
						</a>
					{/if}
					<div class="action focus">
						<Icon name="clock" size={18} />
						<span class="action-text">
							<span class="action-title">{prefs.focusMinutes}-minute focus</span>
							<span class="row-tight focus-row">
								<label for="quick-deck" class="sr-only">Deck</label>
								<select id="quick-deck" class="select input-sm" bind:value={quickDeck}>
									<option value="">All my cards</option>
									{#each data.queue.decks as d (d.deck)}<option value={d.deck}>{d.label} ({d.due} due)</option>{/each}
								</select>
								<button type="button" class="btn btn-sm" disabled={quickBusy || (!dueCards && !data.due.counts.new)} onclick={quickFocus}>{quickBusy ? 'Starting…' : 'Start'}</button>
							</span>
						</span>
					</div>
				</section>
			{:else if id === 'stats'}
				<section class="stats" aria-label="Your numbers">
					<a class="stat" href="/review">
						<span class="stat-label">Due</span>
						<span class="stat-num mono">{data.due.counts.total}</span>
						<span class="stat-sub">{data.due.counts.total ? `${dueCards} reviews${data.due.counts.new ? ` · ${data.due.counts.new} new` : ''}` : 'All caught up'}</span>
					</a>
					<a class="stat" href="/progress">
						<span class="stat-label">This week</span>
						<span class="stat-num mono">{durationLabel(data.week.seconds)}</span>
						<span class="stat-sub">{weekPct !== null ? `${weekPct}% of ${durationLabel(data.week.goalSeconds ?? 0)}` : 'No weekly goal'}</span>
					</a>
					<a class="stat" href="/progress">
						<span class="stat-label">Recall, 30 days</span>
						<span class="stat-num mono">{data.retention.rate === null ? '—' : `${Math.round(data.retention.rate * 100)}%`}</span>
						<span class="stat-sub">{data.retention.rate === null ? 'Not enough reviews' : `Aim ${Math.round(data.desiredRetention * 100)}% · ${data.retention.total} reviews`}</span>
					</a>
					<a class="stat" href="/progress">
						<span class="stat-label">Last full-length</span>
						<span class="stat-num mono">{data.lastFullLength?.total ?? '—'}</span>
						<span class="stat-sub" class:stat-good={(data.lastFullLength?.delta ?? 0) > 0}>
							{#if data.lastFullLength}
								{data.lastFullLength.delta === null ? shortDate(data.lastFullLength.date) : data.lastFullLength.delta === 0 ? 'Same as before' : `${data.lastFullLength.delta > 0 ? '+' : ''}${data.lastFullLength.delta} from the last`}
							{:else}None logged{/if}
						</span>
					</a>
					<div class="stat" title={data.streak.studiedToday ? 'You studied today' : 'Study today to keep it going'}>
						<span class="stat-label">Streak</span>
						<span class="stat-num mono"><span class="flame"><Icon name="flame" size={16} /></span>{data.streak.current}</span>
						<span class="stat-sub">{data.streak.current === 1 ? 'day' : 'days'}{data.streak.studiedToday ? ' · today done' : ''}</span>
					</div>
				</section>
			{:else if id === 'workOn'}
				<section class="card card-flush" aria-labelledby="work-h">
					<div class="card-head row" style="justify-content: space-between">
						<h2 id="work-h">What to work on</h2>
					</div>
					{#if data.workOn.length}
						<div class="list">
							{#each data.workOn as w (w.id)}
								<div class="list-row work">
									<span class="work-icon" class:warn={w.tone === 'warn'}><Icon name={w.icon} size={16} /></span>
									<div style="flex: 1 1 14rem; min-width: 0">
										<div class="list-title">{w.title}</div>
										<div class="list-sub">{w.detail}</div>
									</div>
									<a class="btn btn-sm btn-ghost" href={w.href}>Start<Icon name="arrow-right" size={14} /></a>
								</div>
							{/each}
						</div>
					{:else}
						<p class="small muted pad">You’re all caught up. Learn some new cards, read a chapter, or log a practice set.</p>
					{/if}
				</section>
			{:else if id === 'cars' && data.cars}
				{@const c = data.cars}
				<section class="card card-flush" aria-labelledby="cars-h">
					<div class="card-head row" style="justify-content: space-between">
						<h2 id="cars-h"><span class="sec-bar" data-sec="CARS"></span> CARS</h2>
						<a class="small" href="/cards/cars">All passages</a>
					</div>
					<div class="list">
						{#if c.next}
							<div class="list-row">
								<span class="work-icon"><Icon name="book" size={16} /></span>
								<div style="flex: 1 1 14rem; min-width: 0">
									<div class="list-title truncate">{c.next.title}</div>
									<div class="list-sub">{c.next.source} · {c.next.questions} question{c.next.questions === 1 ? '' : 's'}{c.next.date ? ` · ${shortDate(c.next.date)}` : ''}</div>
								</div>
								<a class="btn btn-sm btn-primary" href="/cards/cars/{c.next.id}">Start</a>
							</div>
						{/if}
						{#if c.daily && c.importedToday < c.perDay}
							<div class="list-row">
								<span class="work-icon"><Icon name="download" size={16} /></span>
								<div style="flex: 1 1 14rem; min-width: 0">
									<div class="list-title">{c.importedToday ? `Import ${c.perDay - c.importedToday} more passage${c.perDay - c.importedToday === 1 ? '' : 's'} today` : 'Today’s Jack Westin passage'}</div>
									<div class="list-sub">{c.bookmarkSet ? 'Brought in by the Medicus extension' : 'Set up the Medicus extension once on the CARS page'}</div>
								</div>
								<a class="btn btn-sm" href="{c.dailyUrl}#medicus={encodeURIComponent(page.url.origin)}" target="_blank" rel="noopener"><Icon name="download" size={14} />Get</a>
							</div>
						{/if}
						{#if c.week.passages}
							<div class="list-row">
								<span class="work-icon"><Icon name="chart" size={16} /></span>
								<div class="small" style="flex: 1 1 auto">
									Last 7 days: <strong>{c.week.passages}</strong> passage{c.week.passages === 1 ? '' : 's'} · <strong>{c.week.total ? Math.round((c.week.correct / c.week.total) * 100) : 0}%</strong> correct · {fmtClock(c.week.avgSeconds)} per passage
								</div>
							</div>
						{:else if !c.next && !(c.daily && c.importedToday < c.perDay)}
							<p class="small muted pad">No CARS passages waiting. <a href="/cards/cars">Import one</a>.</p>
						{/if}
					</div>
				</section>
			{/if}
		{/each}

		{#if extras.length}
			<div class="extras">
				{#each extras as id (id)}
					{#if id === 'queue'}
						<section class="card card-flush" aria-labelledby="queue-h">
							<div class="card-head"><h2 id="queue-h">Due by deck</h2></div>
							{#if data.queue.decks.length || data.queue.madeHere}
								<div class="list">
									{#each data.queue.decks as d (d.deck)}
										<div class="list-row">
											<span class="truncate small" style="flex: 1 1 auto" title={d.label}>{d.label}</span>
											<span class="mono tiny">{d.due}<span class="muted"> due</span>{#if d.new} · {d.new}<span class="muted"> new</span>{/if}</span>
											<a class="btn btn-sm btn-ghost" href="/review?deck={encodeURIComponent(d.deck)}" aria-label="Study {d.label}">Study</a>
										</div>
									{/each}
									{#if data.queue.madeHere}
										<div class="list-row">
											<span class="small" style="flex: 1 1 auto">Cards you made here</span>
											<span class="mono tiny">{data.queue.madeHere}<span class="muted"> due</span></span>
											<a class="btn btn-sm btn-ghost" href="/review">Study</a>
										</div>
									{/if}
								</div>
							{:else}
								<p class="small muted pad">No cards due right now.</p>
							{/if}
							{#if data.queue.retests || data.queue.openMistakes || data.queue.leeches}
								<div class="row-tight pad">
									{#if data.queue.retests}<a class="pill pill-accent" href="/mistakes">{data.queue.retests} retest{data.queue.retests === 1 ? '' : 's'} due</a>{/if}
									{#if data.queue.openMistakes}<a class="pill" href="/mistakes">{data.queue.openMistakes} open mistake{data.queue.openMistakes === 1 ? '' : 's'}</a>{/if}
									{#if data.queue.leeches}<a class="pill pill-warn" href="/cards?state=leech">{data.queue.leeches} leech{data.queue.leeches === 1 ? '' : 'es'}</a>{/if}
								</div>
							{/if}
						</section>
					{:else if id === 'weak'}
						<section class="card" aria-labelledby="weak-h">
							<div class="card-header"><h2 id="weak-h">Weakest areas</h2><a class="small" href="/progress#heatmap">All categories</a></div>
							{#if data.focus.length}
								<div class="stack" style="margin-top: 0.75rem; gap: 0.75rem">
									{#each data.focus as f (f.code)}
										<div>
											<div class="row" style="justify-content: space-between; gap: 0.5rem; font-size: 0.8125rem">
												<span><span class="sec-bar" data-sec={sectionOf(f.code) ?? ''}></span> <span class="mono strong">{f.code}</span> {CATEGORY_SHORT[f.code] ?? f.name}</span>
												<span class="mono strong">{f.value === null ? f.detail : `${Math.round(f.value * 100)}%`}</span>
											</div>
											{#if f.value !== null}<div class="bar warn" style="margin-top: 0.3125rem"><span style="width: {Math.round(f.value * 100)}%"></span></div>{/if}
										</div>
									{/each}
								</div>
							{:else}
								<p class="small muted" style="margin-top: 0.75rem">Not enough data yet. Areas show up after about 20 reviews of tagged cards or 10 practice questions in a category.</p>
							{/if}
						</section>
					{:else if id === 'forecast'}
						<section class="card" aria-labelledby="fc-h">
							<div class="card-header"><h2 id="fc-h">Coming up</h2><span class="tiny muted">cards due, next 7 days</span></div>
							<div class="forecast" role="img" aria-label="Cards due: {forecastLabel}">
								{#each data.forecast.days as d, i (d.day)}
									<div class="fc-col">
										{#if i === 0 || d.projected === maxForecast}<span class="fc-num mono">{d.projected}</span>{/if}
										<div class="fc-bar" class:first={i === 0} style="height: {Math.max(3, Math.round((d.projected / maxForecast) * 96))}px"></div>
									</div>
								{/each}
							</div>
							<div class="fc-labels">
								{#each data.forecast.days as d, i (d.day)}
									<span class:strong={i === 0}>{i === 0 ? 'Today' : weekdayShort(d.day)}</span>
								{/each}
							</div>
							<p class="small" class:warn-text={data.forecast.warning} style="margin-top: 0.75rem">{data.forecast.message}</p>
						</section>
					{:else if id === 'history'}
						<section class="card wide" aria-labelledby="hist-h">
							<div class="card-header"><h2 id="hist-h">Study time, last 14 days</h2><a class="small" href="/progress">All progress</a></div>
							<div style="margin-top: 0.75rem"><HistoryChart days={data.history} today={data.today} /></div>
							{#if data.sessions.length}
								<div class="section-label" style="margin-top: 1rem">Recent sessions</div>
								<ul class="sessions">
									{#each data.sessions as s (s.id)}
										<li>
											<a href="/session/{s.id}">{s.title}</a>
											<span class="tiny muted">{shortDate(s.studyDay)} · {s.done}/{s.total} done{s.rounds ? ` · ${s.rounds} focus round${s.rounds === 1 ? '' : 's'}` : ''}{s.status === 'active' ? ' · in progress' : ''}</span>
										</li>
									{/each}
								</ul>
							{/if}
						</section>
					{:else if id === 'reading'}
						<section class="card" aria-labelledby="cr-h">
							<div class="card-header"><h2 id="cr-h">Continue reading</h2><a class="small" href="/library">Library</a></div>
							{#if reading}
								<div style="margin-top: 0.75rem">
									<div class="strong truncate">{reading.title}</div>
									<div class="small muted truncate">{reading.section ?? `Page ${reading.page}`} · page {reading.page} of {reading.pageCount}</div>
									<div class="bar" style="margin-top: 0.625rem"><span style="width: {reading.progressPct}%"></span></div>
									<div class="tiny muted" style="margin-top: 0.25rem">{reading.progressPct}% done · {reading.highlights} highlights · {reading.cards} cards</div>
									<a class="btn btn-sm" href="/library/{reading.id}/read?page={reading.page}" style="margin-top: 0.75rem">Resume</a>
								</div>
							{:else}
								<p class="small muted" style="margin-top: 0.75rem">Open a book from your library and it shows up here.</p>
							{/if}
						</section>
					{:else if id === 'coach' && data.insights}
						<div class="wide"><AiCoach insights={data.insights} books={data.books} /></div>
					{:else if id === 'tutor'}
						<section class="card" aria-labelledby="tutor-h">
							<div class="card-header"><h2 id="tutor-h">Ask the tutor</h2>{#if data.approvals}<a class="small" href="/tutor/queue">{data.approvals} waiting for your OK</a>{/if}</div>
							<form
								class="row-tight"
								style="margin-top: 0.75rem"
								onsubmit={(e) => {
									e.preventDefault();
									if (tutorQ.trim()) goto(`/tutor?q=${encodeURIComponent(tutorQ.trim())}`);
								}}
							>
								<label for="today-tutor" class="sr-only">Question for the tutor</label>
								<input id="today-tutor" class="input" style="flex: 1 1 10rem" placeholder="What are you stuck on?" bind:value={tutorQ} />
								<button class="btn btn-navy" disabled={!tutorQ.trim()}>Ask</button>
							</form>
						</section>
					{/if}
				{/each}
			</div>
		{/if}

		<p class="customize-hint tiny muted">
			<button type="button" class="link-btn" onclick={() => (customizeOpen = true)}>Choose what Today shows</button>
		</p>
	{/if}
</div>

<Modal bind:open={planOpen} title="Plan a session" wide>
	<SessionBuilder />
</Modal>

<Modal bind:open={customizeOpen} title="Today page">
	<p class="small muted">Turn sections on or off and put them in your order. This is saved for every device.</p>
	<LayoutEditor label="Today sections" items={appearance.account.home} meta={homeMeta} onchange={(home) => setAccountAppearance({ home })} />
	{#snippet footer()}
		<button type="button" class="btn btn-ghost" onclick={() => setAccountAppearance({ home: DEFAULT_HOME.map((h) => ({ ...h })) })}>Reset</button>
		<span class="spacer"></span>
		<button type="button" class="btn btn-primary" onclick={() => (customizeOpen = false)}>Done</button>
	{/snippet}
</Modal>

<style>
	.today {
		max-width: 60rem;
	}
	.greeting {
		font-family: var(--font-reading);
	}
	.start {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
		gap: 0.5rem;
	}
	.action {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		padding: 0.625rem 0.875rem;
		border-radius: var(--radius);
		border: 1px solid var(--border);
		background: var(--surface);
		color: var(--text-2);
		text-decoration: none;
		min-width: 0;
		min-height: 3.5rem;
	}
	a.action:hover {
		border-color: var(--border-strong);
		color: var(--text-2);
	}
	.action.primary {
		background: var(--accent);
		border-color: var(--accent);
		color: var(--on-accent);
	}
	a.action.primary:hover {
		background: var(--accent-hover);
		border-color: var(--accent-hover);
		color: var(--on-accent);
	}
	.action.primary .action-title,
	.action.primary .action-sub {
		color: var(--on-accent);
	}
	.action.primary .action-sub {
		opacity: 0.85;
	}
	.action.quiet {
		color: var(--text-3);
	}
	.action-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1 1 auto;
	}
	.action-title {
		font-weight: 650;
		color: var(--text);
		font-size: 0.875rem;
	}
	.action-sub {
		font-size: 0.75rem;
		color: var(--text-3);
	}
	.focus-row {
		margin-top: 0.25rem;
		flex-wrap: nowrap;
	}
	.focus-row .select {
		width: auto;
		flex: 1 1 7rem;
		min-width: 0;
	}

	.stats {
		display: grid;
		grid-template-columns: repeat(5, minmax(0, 1fr));
		border: 1px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
		overflow: hidden;
	}
	.stat {
		display: flex;
		flex-direction: column;
		padding: 0.75rem 1rem;
		border-right: 1px solid var(--border);
		color: inherit;
		text-decoration: none;
		min-width: 0;
	}
	.stat:last-child {
		border-right: 0;
	}
	a.stat:hover {
		background: var(--hover);
		color: inherit;
	}
	.stat-num {
		font-size: 1.25rem;
		font-weight: 600;
		line-height: 1.3;
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
	}
	.stat .stat-sub {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.flame {
		display: inline-flex;
		color: var(--accent);
	}
	@media (max-width: 720px) {
		.stats {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.stat {
			border-bottom: 1px solid var(--border);
		}
		.stat:nth-child(2n) {
			border-right: 0;
		}
	}

	.card-head h2 {
		font-size: 0.875rem;
	}
	.pad {
		padding: 0 1rem 0.875rem;
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
	.work-icon.warn {
		background: var(--weak-soft);
		color: var(--weak-text);
	}

	.extras {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(18rem, 1fr));
		gap: 1rem;
		align-items: start;
	}
	.extras .wide {
		grid-column: 1 / -1;
	}
	.sessions {
		list-style: none;
		margin: 0.375rem 0 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.sessions li {
		display: flex;
		flex-wrap: wrap;
		gap: 0.125rem 0.625rem;
		align-items: baseline;
		font-size: 0.8125rem;
	}
	.forecast {
		display: flex;
		align-items: flex-end;
		gap: 0.5rem;
		height: 120px;
		margin-top: 0.75rem;
		border-bottom: 1px solid var(--border-strong);
		padding: 0 4px;
	}
	.fc-col {
		flex: 1 1 0;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
	}
	.fc-num {
		font-size: 0.6875rem;
		font-weight: 600;
	}
	.fc-bar {
		width: 100%;
		max-width: 22px;
		border-radius: 3px 3px 0 0;
		background: var(--accent-muted);
	}
	.fc-bar.first {
		background: var(--accent);
	}
	.fc-labels {
		display: flex;
		gap: 0.5rem;
		padding: 6px 4px 0;
		font-size: 0.6875rem;
		color: var(--text-3);
	}
	.fc-labels span {
		flex: 1 1 0;
		text-align: center;
	}
	.fc-labels .strong {
		color: var(--text);
	}
	.warn-text {
		color: var(--weak-text);
		font-weight: 600;
	}
	.customize-hint {
		text-align: center;
	}
	.link-btn {
		background: none;
		border: 0;
		padding: 0;
		color: var(--text-3);
		font: inherit;
		cursor: pointer;
		text-decoration: underline;
		text-underline-offset: 2px;
	}
	.link-btn:hover {
		color: var(--text);
	}
</style>
