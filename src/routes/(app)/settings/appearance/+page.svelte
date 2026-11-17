<script lang="ts">
	import { onDestroy } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { appearance, saveStatus, setAccountAppearance, setDeviceAppearance, themeChoice } from '#lib/client/appearance.svelte.js';
	import {
		HOLIDAYS,
		PAGE_FOR_THEME,
		PAGE_STYLES,
		SEASON_THEMES,
		SEASONS,
		seasonOfDate,
		TEXT_SIZES,
		THEMES,
		type DecorSeason,
		type HolidayId,
		type ThemeChoice,
		type ThemeId
	} from '#lib/appearance.js';
	import { DECORATIONS, ramadanPeriods, type Decoration } from '#lib/decor/calendar.js';
	import { renderMarkdown } from '#lib/markdown.js';

	// Theme settings go to this device when "Use a different theme on this device" is on, else to the account.
	const choice = $derived(themeChoice());
	const own = $derived(appearance.device.override);

	function setChoice(patch: Partial<ThemeChoice>) {
		if (own) setDeviceAppearance({ choice: { ...appearance.device.choice, ...patch } });
		else setAccountAppearance(patch);
	}

	function setOwn(on: boolean) {
		// Start this device's own choice from what the account has, so nothing jumps.
		setDeviceAppearance(on ? { override: true, choice: { ...appearance.account } } : { override: false });
	}

	const everyday = THEMES.filter((t) => !t.season);
	const themeName = (id: ThemeId) => THEMES.find((t) => t.id === id)?.name ?? id;
	const pageName = (id: string) => PAGE_STYLES.find((p) => p.id === id)?.name ?? id;
	const matchResolves = $derived(pageName(PAGE_FOR_THEME[appearance.theme]));
	const nowSeason = seasonOfDate(new Date());
	const year = new Date().getFullYear();
	const ramadan = $derived(ramadanPeriods(year, appearance.account.ramadanOffset));
	const fmt = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

	function preview(id: Decoration) {
		appearance.preview = appearance.preview === id ? null : id;
	}
	onDestroy(() => (appearance.preview = null));

	const MODES: [ThemeChoice['mode'], string][] = [
		['pick', 'Pick one'],
		['season', 'Follow the seasons'],
		['system', 'Match device'],
		['time', 'By time of day']
	];
	const DECOR_SEASONS: [DecorSeason, string][] = [
		['match', 'Match theme'],
		['calendar', 'By the calendar'],
		['spring', 'Spring'],
		['summer', 'Summer'],
		['fall', 'Fall'],
		['winter', 'Winter']
	];
</script>

<svelte:head><title>Appearance · Settings · Medicus Vitae</title></svelte:head>

<section class="card stack" aria-labelledby="theme-h">
	<div>
		<h2 id="theme-h">Theme</h2>
		<p class="small muted" style="margin-top: 0.25rem">Changes apply right away{own ? ', on this device only' : ' and are saved to your account, so every device gets them'}.</p>
	</div>

	<div class="segmented" role="radiogroup" aria-label="How the theme is chosen">
		{#each MODES as [v, l] (v)}
			<button type="button" role="radio" aria-checked={choice.mode === v} onclick={() => setChoice({ mode: v })}>{l}</button>
		{/each}
	</div>

	{#if choice.mode === 'pick'}
		<div class="group-label">Everyday</div>
		<div class="themes" role="radiogroup" aria-label="Everyday themes">
			{#each everyday as t (t.id)}
				{@render themeCard(t.id, t.name, t.bestFor)}
			{/each}
		</div>
		<div class="group-label">Seasons <span class="muted" style="font-weight: 400">· any time of year</span></div>
		<div class="themes" role="radiogroup" aria-label="Season themes">
			{#each SEASONS as s (s.id)}
				{@render themeCard(SEASON_THEMES[s.id].day, s.name, 'Day')}
				{@render themeCard(SEASON_THEMES[s.id].night, `${s.name} Night`, 'Night')}
			{/each}
		</div>
	{:else if choice.mode === 'season'}
		<p class="small">The theme changes with the season: spring from March 1, summer from June 1, fall from September 1 and winter from December 1. Right now it’s <strong>{SEASONS.find((s) => s.id === nowSeason)?.name.toLowerCase()}</strong>.</p>
		<div class="season-strip" aria-hidden="true">
			{#each SEASONS as s (s.id)}
				<div class="season-chip" class:now={s.id === nowSeason}>
					{@render miniPreview(SEASON_THEMES[s.id].day)}
					<span class="tiny strong">{s.name}</span>
				</div>
			{/each}
		</div>
		<div class="field">
			<span class="label" id="shade-l">Day or night version</span>
			<div class="segmented" role="radiogroup" aria-labelledby="shade-l">
				{#each [['system', 'Match device'], ['time', 'By time of day'], ['light', 'Always day'], ['dark', 'Always night']] as [v, l] (v)}
					<button type="button" role="radio" aria-checked={choice.seasonShade === v} onclick={() => setChoice({ seasonShade: v as ThemeChoice['seasonShade'] })}>{l}</button>
				{/each}
			</div>
		</div>
		{#if choice.seasonShade === 'time'}{@render darkTimes()}{/if}
		<p class="small muted">Showing now: <strong>{themeName(appearance.theme)}</strong>.</p>
	{:else}
		<div class="form-grid">
			<div class="field">
				<label for="light-theme">Light theme{choice.mode === 'time' ? ' (daytime)' : ''}</label>
				<select id="light-theme" class="select" value={choice.lightTheme} onchange={(e) => setChoice({ lightTheme: (e.currentTarget as HTMLSelectElement).value as ThemeId })}>
					{@render themeOptions()}
				</select>
			</div>
			<div class="field">
				<label for="dark-theme">Dark theme{choice.mode === 'time' ? ' (night)' : ''}</label>
				<select id="dark-theme" class="select" value={choice.darkTheme} onchange={(e) => setChoice({ darkTheme: (e.currentTarget as HTMLSelectElement).value as ThemeId })}>
					{@render themeOptions()}
				</select>
			</div>
		</div>
		{#if choice.mode === 'time'}{@render darkTimes()}{/if}
		<p class="small muted">
			Showing now: <strong>{themeName(appearance.theme)}</strong>{choice.mode === 'system' ? ` (this device is set to ${appearance.prefersDark ? 'dark' : 'light'})` : ''}.
		</p>
	{/if}

	<label class="checkbox"><input type="checkbox" checked={own} onchange={(e) => setOwn((e.currentTarget as HTMLInputElement).checked)} />Use a different theme on this device</label>
	<p class="hint" style="margin-top: -0.75rem">For example Midnight on your phone and Clinic Light on your laptop. Saved in this browser only.</p>
	{#if saveStatus.error}<div class="warning" role="status"><Icon name="alert" size={16} />{saveStatus.error}</div>{/if}
</section>

<section class="card stack" aria-labelledby="decor-h">
	<div>
		<h2 id="decor-h">Decorations</h2>
		<p class="small muted" style="margin-top: 0.25rem">A little seasonal company. They never block a click or cover what you’re studying.</p>
	</div>
	<div class="segmented" role="radiogroup" aria-label="Decorations">
		{#each [['off', 'Off'], ['seasons', 'Seasons only'], ['all', 'Seasons and holidays']] as [v, l] (v)}
			<button type="button" role="radio" aria-checked={appearance.account.decorations === v} onclick={() => setAccountAppearance({ decorations: v as 'off' | 'seasons' | 'all' })}>{l}</button>
		{/each}
	</div>
	{#if appearance.account.decorations !== 'off'}
		<div class="field">
			<span class="label" id="spread-l">Where</span>
			<div class="segmented" role="radiogroup" aria-labelledby="spread-l">
				{#each [['screen', 'Whole screen'], ['sidebar', 'Sidebar only']] as [v, l] (v)}
					<button type="button" role="radio" aria-checked={appearance.account.decorSpread === v} onclick={() => setAccountAppearance({ decorSpread: v as 'sidebar' | 'screen' })}>{l}</button>
				{/each}
			</div>
			<span class="hint">
				{appearance.account.decorSpread === 'screen'
					? 'A few drift faintly across the whole screen. While you study, or with motion set to Still, they stay in the sidebar.'
					: 'They stay in the sidebar, clear of your work. On phones, along the screen edges.'}
			</span>
		</div>
		<div class="field">
			<span class="label" id="dseason-l">Which season</span>
			<div class="segmented" role="radiogroup" aria-labelledby="dseason-l">
				{#each DECOR_SEASONS as [v, l] (v)}
					<button type="button" role="radio" aria-checked={appearance.account.decorSeason === v} onclick={() => setAccountAppearance({ decorSeason: v })}>{l}</button>
				{/each}
			</div>
			<span class="hint">
				{appearance.account.decorSeason === 'match'
					? 'A season theme brings its own decorations; other themes follow the calendar.'
					: appearance.account.decorSeason === 'calendar'
						? 'Spring petals, summer fireflies, fall leaves or winter snow, by today’s date.'
						: 'This season’s decorations all year round.'}
			</span>
		</div>
		{#if appearance.account.decorations === 'all'}
			<div class="field">
				<span class="label">Holidays <span class="muted" style="font-weight: 400">(shown during their dates, instead of the season)</span></span>
				<div class="holidays">
					{#each HOLIDAYS as h (h.id)}
						<label class="checkbox">
							<input
								type="checkbox"
								checked={appearance.account.holidays[h.id]}
								onchange={(e) => setAccountAppearance({ holidays: { ...appearance.account.holidays, [h.id]: (e.currentTarget as HTMLInputElement).checked } as Record<HolidayId, boolean> })}
							/>{h.name}
						</label>
					{/each}
				</div>
			</div>
			{#if appearance.account.holidays.ramadan}
				<div class="form-grid">
					<div class="field">
						<label for="ramadan-offset">Ramadan dates</label>
						<select id="ramadan-offset" class="select" value={String(appearance.account.ramadanOffset)} onchange={(e) => setAccountAppearance({ ramadanOffset: Number((e.currentTarget as HTMLSelectElement).value) as -1 | 0 | 1 })}>
							<option value="-1">One day earlier</option>
							<option value="0">Umm al-Qura calendar</option>
							<option value="1">One day later</option>
						</select>
						<span class="hint">
							{#if ramadan.length}Ramadan {year}: {ramadan.map((r) => `${fmt(r.start)} – ${fmt(r.end)}`).join(' and ')}.{/if}
							Move it by a day if your local moon sighting differs.
						</span>
					</div>
					<label class="checkbox" style="align-self: center"><input type="checkbox" checked={appearance.account.ramadanGreeting} onchange={(e) => setAccountAppearance({ ramadanGreeting: (e.currentTarget as HTMLInputElement).checked })} />“Ramadan Kareem” on Today during Ramadan</label>
				</div>
			{/if}
		{/if}
		<div class="field">
			<span class="label" id="motion-l">Motion</span>
			<div class="segmented" role="radiogroup" aria-labelledby="motion-l">
				{#each [['animated', 'Animated'], ['still', 'Still']] as [v, l] (v)}
					<button type="button" role="radio" aria-checked={appearance.account.motion === v} onclick={() => setAccountAppearance({ motion: v as 'animated' | 'still' })}>{l}</button>
				{/each}
			</div>
			<span class="hint">With your device’s “reduce motion” setting on, decorations always stay still.</span>
		</div>
		<label class="checkbox"><input type="checkbox" checked={appearance.account.pauseWhileStudying} onchange={(e) => setAccountAppearance({ pauseWhileStudying: (e.currentTarget as HTMLInputElement).checked })} />Hold still while I study</label>
		<p class="hint" style="margin-top: -0.75rem">During reviews, reading, sessions and quizzes they stay visible but stop moving.</p>
		<div class="field">
			<span class="label">Try one now</span>
			<div class="row-tight">
				{#each DECORATIONS as d (d.id)}
					<button type="button" class="btn btn-sm" aria-pressed={appearance.preview === d.id} onclick={() => preview(d.id)}>{appearance.preview === d.id ? `Stop ${d.name}` : d.name}</button>
				{/each}
			</div>
			<span class="hint">Shows a decoration now, whatever the date, until you leave this page.</span>
		</div>
	{/if}
</section>

<section class="card" aria-labelledby="layout-h">
	<div class="card-header">
		<div>
			<h2 id="layout-h">Layout and motion</h2>
			<p class="card-sub">Menu items, their order and the Today page are under <a href="/settings/layout">Menu & Today</a>.</p>
		</div>
	</div>
	<div class="setting">
		<div>
			<div class="setting-title">Fold the sidebar to icons</div>
			<div class="setting-hint">On this device. Press <span class="kbd">[</span> anywhere to fold or open it.</div>
		</div>
		<input type="checkbox" class="switch" aria-label="Fold the sidebar to icons" checked={appearance.device.sidebar === 'collapsed'} onchange={(e) => setDeviceAppearance({ sidebar: (e.currentTarget as HTMLInputElement).checked ? 'collapsed' : 'expanded' })} />
	</div>
	<div class="setting">
		<div>
			<div class="setting-title">Test-day countdown in the menu</div>
			<div class="setting-hint">Days left until your test date, under the logo.</div>
		</div>
		<input type="checkbox" class="switch" aria-label="Test-day countdown in the menu" checked={appearance.account.showTestDay} onchange={(e) => setAccountAppearance({ showTestDay: (e.currentTarget as HTMLInputElement).checked })} />
	</div>
	<div class="setting">
		<div>
			<div class="setting-title">Focus mode during reviews</div>
			<div class="setting-hint">While you review flashcards, only the card shows: no menu, stats or decorations.</div>
		</div>
		<input type="checkbox" class="switch" aria-label="Focus mode during reviews" checked={appearance.account.focusMode} onchange={(e) => setAccountAppearance({ focusMode: (e.currentTarget as HTMLInputElement).checked })} />
	</div>
	<div class="setting">
		<div>
			<div class="setting-title">Section colors</div>
			<div class="setting-hint">
				<span class="sec-bar" data-sec="CP"></span> Chem/Phys · <span class="sec-bar" data-sec="CARS"></span> CARS · <span class="sec-bar" data-sec="BB"></span> Bio/Biochem ·
				<span class="sec-bar" data-sec="PS"></span> Psych/Soc, next to section names, categories and card tags.
			</div>
		</div>
		<input type="checkbox" class="switch" aria-label="Section colors" checked={appearance.account.sectionColors} onchange={(e) => setAccountAppearance({ sectionColors: (e.currentTarget as HTMLInputElement).checked })} />
	</div>
	<div class="setting">
		<div>
			<div class="setting-title">Reduce motion</div>
			<div class="setting-hint">On this device. Turns off transitions and keeps decorations still.</div>
		</div>
		<input type="checkbox" class="switch" aria-label="Reduce motion" checked={appearance.device.reduceMotion} onchange={(e) => setDeviceAppearance({ reduceMotion: (e.currentTarget as HTMLInputElement).checked })} />
	</div>
</section>

<section class="card stack" aria-labelledby="text-h">
	<h2 id="text-h">Text</h2>
	<div class="field">
		<span class="label" id="size-l">Text size</span>
		<div class="segmented" role="radiogroup" aria-labelledby="size-l">
			{#each TEXT_SIZES as s (s.id)}
				<button type="button" role="radio" aria-checked={appearance.account.textSize === s.id} onclick={() => setAccountAppearance({ textSize: s.id })}>{s.name}</button>
			{/each}
		</div>
		<span class="hint">For app text, cards and notes. Book pages keep their own zoom in the reader.</span>
	</div>
	<div class="field">
		<span class="label" id="font-l">Font for notes and cards <span class="muted" style="font-weight: 400">(this device)</span></span>
		<div class="segmented" role="radiogroup" aria-labelledby="font-l">
			{#each [['serif', 'Serif'], ['sans', 'Sans-serif'], ['legible', 'Easy to read']] as [v, l] (v)}
				<button type="button" role="radio" aria-checked={appearance.device.readingFont === v} onclick={() => setDeviceAppearance({ readingFont: v as 'serif' | 'sans' | 'legible' })}>{l}</button>
			{/each}
		</div>
	</div>
	<div class="field">
		<span class="label" id="ls-l">Line spacing <span class="muted" style="font-weight: 400">(this device)</span></span>
		<div class="segmented" role="radiogroup" aria-labelledby="ls-l">
			{#each [['normal', 'Normal'], ['relaxed', 'Relaxed']] as [v, l] (v)}
				<button type="button" role="radio" aria-checked={appearance.device.lineSpacing === v} onclick={() => setDeviceAppearance({ lineSpacing: v as 'normal' | 'relaxed' })}>{l}</button>
			{/each}
		</div>
	</div>
	<div class="preview-box">
		<div class="tiny muted strong">Preview</div>
		<div class="md reading" style="margin-top: 0.5rem">
			{@html renderMarkdown('**Michaelis–Menten:** a low Km means high affinity, so the enzyme reaches half of Vmax at a lower substrate concentration.')}
		</div>
	</div>
</section>

<section class="card stack" aria-labelledby="page-h">
	<div>
		<h2 id="page-h">Book pages</h2>
		<p class="small muted" style="margin-top: 0.25rem">How book pages look in the reader, separate from the app theme. Highlights keep their colors.</p>
	</div>
	<div class="pills" role="radiogroup" aria-label="Page style">
		{#each [{ id: 'match', name: 'Match theme' }, ...PAGE_STYLES] as p (p.id)}
			<button type="button" role="radio" class="pill-btn" aria-checked={appearance.account.page === p.id} onclick={() => setAccountAppearance({ page: p.id as never })}>{p.name}</button>
		{/each}
	</div>
	<p class="small muted">{appearance.account.page === 'match' ? `With ${themeName(appearance.theme)}, pages show as ${matchResolves}.` : `Always ${pageName(appearance.account.page)}.`}</p>
	<div class="page-sample" data-page={appearance.pageStyle} aria-label="Sample page">
		<div class="pdf-page sample-sheet">
			<div class="sample-text">
				<div class="sample-h">5.2 Enzyme kinetics</div>
				<p>The Michaelis–Menten equation relates reaction rate to substrate concentration. <span class="sample-hl">K<sub>m</sub> is the substrate concentration at half of V<sub>max</sub>.</span> A competitive inhibitor raises the apparent K<sub>m</sub>.</p>
				<span class="sample-note">Note</span>
			</div>
		</div>
	</div>
</section>

{#snippet themeCard(id: ThemeId, name: string, sub: string)}
	<button type="button" role="radio" class="theme-card" aria-checked={choice.theme === id} onclick={() => setChoice({ theme: id })}>
		{@render miniPreview(id)}
		<span class="theme-name">
			{name}
			{#if choice.theme === id}<span class="theme-check"><Icon name="check" size={14} stroke={3} /></span>{/if}
		</span>
		<span class="tiny muted">{sub}</span>
	</button>
{/snippet}

{#snippet themeOptions()}
	<optgroup label="Everyday">
		{#each everyday as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
	</optgroup>
	<optgroup label="Seasons">
		{#each THEMES.filter((t) => t.season) as t (t.id)}<option value={t.id}>{t.name}</option>{/each}
	</optgroup>
{/snippet}

{#snippet darkTimes()}
	<div class="field">
		<span class="label">Night from … until</span>
		<div class="row-tight">
			<label for="dark-from" class="sr-only">Night starts at</label>
			<input id="dark-from" type="time" class="input" style="width: 8.5rem" value={choice.darkFrom} onchange={(e) => setChoice({ darkFrom: (e.currentTarget as HTMLInputElement).value })} />
			<span class="muted">to</span>
			<label for="dark-to" class="sr-only">Night ends at</label>
			<input id="dark-to" type="time" class="input" style="width: 8.5rem" value={choice.darkTo} onchange={(e) => setChoice({ darkTo: (e.currentTarget as HTMLInputElement).value })} />
		</div>
	</div>
{/snippet}

{#snippet miniPreview(id: ThemeId)}
	<span class="mini" data-theme={id} aria-hidden="true">
		<span class="mini-side"><span class="mini-nav active"></span><span class="mini-nav"></span><span class="mini-nav"></span></span>
		<span class="mini-main">
			<span class="mini-card"><span class="mini-line strong"></span><span class="mini-line"></span><span class="mini-bar"><span></span></span></span>
			<span class="mini-row"><span class="mini-btn"></span><span class="mini-dot"></span></span>
		</span>
	</span>
{/snippet}

<style>
	.group-label {
		font-size: 0.8125rem;
		font-weight: 600;
		color: var(--text-2);
		margin-bottom: -0.5rem;
	}
	.themes {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(9.5rem, 1fr));
		gap: 0.75rem;
	}
	.theme-card {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.125rem;
		padding: 0.5rem 0.5rem 0.625rem;
		border: 2px solid var(--border);
		border-radius: var(--radius-lg);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
		text-align: left;
	}
	.theme-card[aria-checked='true'] {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.theme-name {
		display: flex;
		align-items: center;
		gap: 0.375rem;
		font-weight: 600;
		font-size: 0.875rem;
		margin-top: 0.375rem;
		width: 100%;
	}
	.theme-check {
		display: inline-flex;
		margin-left: auto;
		width: 20px;
		height: 20px;
		border-radius: 999px;
		background: var(--accent);
		color: var(--on-accent);
		align-items: center;
		justify-content: center;
	}
	/* A small live preview: its colors come from data-theme on the preview itself. */
	.mini {
		display: flex;
		width: 100%;
		height: 64px;
		border-radius: 8px;
		overflow: hidden;
		background: var(--bg);
		border: 1px solid var(--border);
	}
	.mini-side {
		width: 28%;
		background: var(--sidebar);
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px 5px;
	}
	.mini-nav {
		height: 6px;
		border-radius: 3px;
		background: var(--surface-2);
	}
	.mini-nav.active {
		background: var(--accent-soft);
		outline: 1px solid var(--accent-text);
	}
	.mini-main {
		flex: 1;
		display: flex;
		flex-direction: column;
		gap: 6px;
		padding: 7px;
	}
	.mini-card {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 5px;
		padding: 5px;
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.mini-line {
		height: 4px;
		width: 70%;
		border-radius: 2px;
		background: var(--text-3);
	}
	.mini-line.strong {
		width: 50%;
		background: var(--text);
	}
	.mini-bar {
		height: 4px;
		border-radius: 2px;
		background: var(--surface-2);
		overflow: hidden;
	}
	.mini-bar span {
		display: block;
		width: 60%;
		height: 100%;
		background: var(--accent);
	}
	.mini-row {
		display: flex;
		align-items: center;
		gap: 5px;
	}
	.mini-btn {
		width: 40%;
		height: 8px;
		border-radius: 4px;
		background: var(--ink);
	}
	.mini-dot {
		width: 8px;
		height: 8px;
		border-radius: 999px;
		background: var(--decor-1, var(--weak));
	}
	.season-strip {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: 0.625rem;
	}
	.season-chip {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
		padding: 0.375rem;
		border-radius: var(--radius);
		border: 2px solid transparent;
		opacity: 0.7;
	}
	.season-chip.now {
		border-color: var(--accent);
		opacity: 1;
	}
	.pills {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
	}
	.pill-btn {
		min-height: 40px;
		padding: 0 1rem;
		border-radius: 999px;
		border: 1px solid var(--border-strong);
		background: var(--surface);
		color: var(--text-2);
		font-weight: 600;
		font-size: 0.8125rem;
		cursor: pointer;
	}
	.pill-btn[aria-checked='true'] {
		background: var(--accent-soft);
		border-color: var(--accent);
		color: var(--accent-text);
	}
	.page-sample {
		background: var(--surface-2);
		border-radius: var(--radius);
		padding: 1rem;
		display: flex;
		justify-content: center;
	}
	.sample-sheet {
		position: relative;
		width: min(26rem, 100%);
		background: var(--page-bg);
		color: var(--page-text);
		border-radius: 3px;
		box-shadow: var(--shadow);
		padding: 1rem 1.25rem;
		font-family: var(--font-reading);
		font-size: 0.875rem;
		line-height: 1.55;
	}
	.sample-h {
		font-weight: 700;
		color: var(--page-text);
		border-bottom: 1px solid var(--page-rule);
		padding-bottom: 0.25rem;
		margin-bottom: 0.5rem;
	}
	.sample-text p {
		color: var(--page-text-2);
	}
	.sample-hl {
		background: var(--page-hl);
		color: var(--page-text);
	}
	.sample-note {
		display: inline-block;
		margin-top: 0.5rem;
		font-family: var(--font-ui);
		font-size: 0.75rem;
		font-weight: 600;
		padding: 0.125rem 0.5rem;
		border-radius: 6px;
		background: var(--page-note-bg);
		color: var(--page-note-text);
	}
	.preview-box {
		background: var(--surface-2);
		border-radius: var(--radius);
		padding: 1rem;
	}
	.holidays {
		display: flex;
		flex-wrap: wrap;
		gap: 0 1.5rem;
	}
	@media (max-width: 560px) {
		.season-strip {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
	}
</style>
