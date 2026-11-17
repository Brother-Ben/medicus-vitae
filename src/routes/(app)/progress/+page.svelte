<script lang="ts">
	import { enhance } from '$app/forms';
	import CategorySelect from '#lib/components/CategorySelect.svelte';
	import FlImportDialog from '#lib/components/FlImportDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Modal from '#lib/components/Modal.svelte';
	import { toast } from '#lib/client/toast.svelte.js';
	import { FULL_LENGTH_PROVIDERS, PRACTICE_SOURCES, SECTION_SCORE, SKILLS } from '#lib/aamc.js';
	import { durationLabel, mediumDate, shortDate, weekdayShort } from '#lib/dates.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let evidence = $state<'recall' | 'practice' | 'fullLength'>('recall');
	let flOpen = $state(false);
	let importOpen = $state(false);
	let practiceOpen = $state(false);
	let practiceCode = $state<string | null>(null);

	// ------------------------------------------------- full-length chart
	const flPoints = $derived(data.fl.list.filter((f) => f.total != null));
	const chart = $derived.by(() => {
		const W = 600;
		const H = 250;
		const left = 50;
		const right = 590;
		const top = 20;
		const bottom = 210;
		const totals = flPoints.map((f) => f.total!);
		const vals = data.goal ? [...totals, data.goal] : totals;
		const lo = Math.max(472, Math.floor((Math.min(...vals) - 4) / 10) * 10);
		const hi = Math.min(528, Math.ceil((Math.max(...vals) + 4) / 10) * 10);
		const y = (v: number) => bottom - ((v - lo) / Math.max(1, hi - lo)) * (bottom - top);
		const t0 = flPoints.length ? Date.parse(flPoints[0].date) : 0;
		const t1 = flPoints.length ? Date.parse(flPoints[flPoints.length - 1].date) : 1;
		const x = (d: string) => (flPoints.length < 2 || t1 === t0 ? (left + right) / 2 : left + 30 + ((Date.parse(d) - t0) / (t1 - t0)) * (right - left - 50));
		const ticks: number[] = [];
		for (let v = lo; v <= hi; v += 10) ticks.push(v);
		return { W, H, left, right, top, bottom, y, x, ticks, lo, hi };
	});
	const flSummary = $derived(
		`Full-length scores: ${flPoints.map((f) => `${shortDate(f.date)} ${f.total}`).join(', ')}${data.goal ? `. Goal ${data.goal}.` : ''}`
	);

	const sections = $derived.by(() => {
		const latest = data.fl.latest;
		const prev = data.fl.previous;
		if (!latest) return [];
		return (
			[
				['cp', 'Chem/Phys', 'CP'],
				['cars', 'CARS', 'CARS'],
				['bb', 'Bio/Biochem', 'BB'],
				['ps', 'Psych/Soc', 'PS']
			] as const
		).map(([k, name, code]) => {
			const score = latest[k];
			const before = prev?.[k] ?? null;
			return {
				name,
				code,
				score,
				delta: score != null && before != null ? score - before : null,
				pct: score != null ? Math.round(((score - SECTION_SCORE.min) / (SECTION_SCORE.max - SECTION_SCORE.min)) * 100) : 0
			};
		});
	});

	// ------------------------------------------------------- heatmap
	function heatClass(v: number | null) {
		if (v === null) return 'heat-none';
		const p = v * 100;
		if (p < 62) return 'heat-1';
		if (p < 70) return 'heat-2';
		if (p < 78) return 'heat-3';
		if (p < 85) return 'heat-4';
		return 'heat-5';
	}

	function flClass(missed: number) {
		if (missed >= 3) return 'heat-1';
		if (missed === 2) return 'heat-2';
		if (missed === 1) return 'heat-3';
		return 'heat-none';
	}

	// ------------------------------------------------------- study time
	const maxSeconds = $derived(Math.max(60, (data.dailyGoal ?? 0) * 60, ...data.series.map((d) => d.seconds)));
	const totalSeconds = $derived(data.series.reduce((a, d) => a + d.seconds, 0));
	const weekly = $derived(data.series.length > 45);
	const bars = $derived.by(() => {
		if (!weekly) return data.series.map((d) => ({ label: d.day, seconds: d.seconds }));
		const out: { label: string; seconds: number }[] = [];
		for (let i = 0; i < data.series.length; i += 7) {
			const chunk = data.series.slice(i, i + 7);
			out.push({ label: chunk[0].day, seconds: chunk.reduce((a, d) => a + d.seconds, 0) });
		}
		return out;
	});
	const barMax = $derived(Math.max(60, ...bars.map((b) => b.seconds), weekly ? 0 : (data.dailyGoal ?? 0) * 60));

	const today = $derived(data.today);
	const testDay = $derived(data.testDate ? mediumDate(data.testDate) : null);

	/** Closes the dialog and confirms once the server accepted the form. */
	function onSaved(close: () => void, message: string) {
		return () =>
			async ({ result, update }: { result: { type: string }; update: (o?: { reset?: boolean }) => Promise<void> }) => {
				await update({ reset: result.type === 'success' });
				if (result.type === 'success') {
					close();
					toast(message);
				}
			};
	}
</script>

<svelte:head><title>Progress · Medicus Vitae</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div>
			<h1>Progress</h1>
			<div class="subtitle">
				{data.goal ? `Goal ${data.goal}` : 'No goal set'}{testDay ? ` · Test day ${testDay}` : ''} · {data.streak.current}-day streak
			</div>
		</div>
		<div class="segmented" role="group" aria-label="Time range">
			<a href="/progress?range=7" aria-current={data.range === '7' ? 'page' : undefined}>7 days</a>
			<a href="/progress?range=30" aria-current={data.range === '30' ? 'page' : undefined}>30 days</a>
			<a href="/progress?range=all" aria-current={data.range === 'all' ? 'page' : undefined}>All time</a>
		</div>
	</header>

	<div class="columns" style="align-items: stretch">
		<section class="card" style="flex: 2 1 30rem; min-width: 0" aria-labelledby="fl-h">
			<div class="card-header">
				<h2 id="fl-h">Full-length scores</h2>
				<div class="row-tight">
					<button type="button" class="btn btn-sm" onclick={() => (importOpen = true)}><Icon name="download" size={15} />Import from AAMC</button>
					<button type="button" class="btn btn-sm btn-ghost" onclick={() => (flOpen = true)}><Icon name="plus" size={15} />Scores only</button>
				</div>
			</div>
			<div class="card-sub">Total score, 472–528 scale</div>
			{#if flPoints.length}
				<svg viewBox="0 0 {chart.W} {chart.H}" width="100%" role="img" aria-label={flSummary} class="fl-chart">
					{#each chart.ticks as t (t)}
						<line x1={chart.left} x2={chart.right} y1={chart.y(t)} y2={chart.y(t)} class={t === chart.lo ? 'axis' : 'grid'} />
						<text x={chart.left - 10} y={chart.y(t) + 4} text-anchor="end" class="tick">{t}</text>
					{/each}
					{#if data.goal}
						<line x1={chart.left} x2={chart.right} y1={chart.y(data.goal)} y2={chart.y(data.goal)} class="goal" />
						<text x={chart.right - 4} y={chart.y(data.goal) - 7} text-anchor="end" class="goal-label">Goal {data.goal}</text>
					{/if}
					{#if flPoints.length > 1}
						<polyline points={flPoints.map((f) => `${chart.x(f.date)},${chart.y(f.total!)}`).join(' ')} class="line" />
					{/if}
					{#each flPoints as f, i (f.id)}
						<a href="/progress/full-lengths/{f.id}" aria-label="{f.provider} {f.form}, {shortDate(f.date)}: {f.total}">
							<circle cx={chart.x(f.date)} cy={chart.y(f.total!)} r={i === flPoints.length - 1 ? 6 : 5} class="dot"><title>{shortDate(f.date)}: {f.total}</title></circle>
						</a>
						{#if i === flPoints.length - 1 || (i === 0 && chart.x(f.date) !== chart.x(flPoints[flPoints.length - 1].date))}
							<text x={chart.x(f.date)} y={chart.y(f.total!) + (i === flPoints.length - 1 ? -12 : 22)} text-anchor="middle" class="val">{f.total}</text>
						{/if}
						{#if flPoints.length <= 8 || i % Math.ceil(flPoints.length / 8) === 0 || i === flPoints.length - 1}
							<text x={chart.x(f.date)} y={chart.bottom + 24} text-anchor="middle" class="tick">{shortDate(f.date)}</text>
						{/if}
					{/each}
				</svg>
			{:else}
				<div class="empty" style="padding: 2rem 0">
					<p>No full-lengths yet. Take AAMC’s practice exams on its site, then import the results here: paste the score report and review list, and see every question you got right or wrong.</p>
				</div>
			{/if}
		</section>

		<section class="card" style="flex: 1 1 18rem; min-width: 0" aria-labelledby="sec-h">
			<h2 id="sec-h">Latest by section</h2>
			{#if data.fl.latest}
				<div class="card-sub">{data.fl.latest.provider} {data.fl.latest.form} on {shortDate(data.fl.latest.date)} · each section 118–132</div>
				<div class="stack" style="margin-top: 1.125rem">
					{#each sections as s (s.name)}
						<div>
							<div class="row" style="justify-content: space-between; font-size: 0.875rem">
								<span class="strong"><span class="sec-bar" data-sec={s.code}></span> {s.name}</span>
								<span>
									<span class="mono strong" style="font-size: 1rem">{s.score ?? '—'}</span>
									{#if s.delta !== null}
										<span class="small strong" style:color={s.delta > 0 ? 'var(--accent-text)' : s.delta < 0 ? 'var(--weak-text)' : 'var(--text-3)'}>
											{s.delta > 0 ? `+${s.delta}` : s.delta === 0 ? '±0' : s.delta}
										</span>
									{/if}
								</span>
							</div>
							<div class="bar bar-lg" style="margin-top: 0.375rem"><span style="width: {s.pct}%"></span></div>
						</div>
					{/each}
				</div>
				<a class="btn btn-block" style="margin-top: 1.25rem" href="/progress/full-lengths/{data.fl.latest.id}">Review this exam</a>
			{:else}
				<p class="small muted" style="margin-top: 0.75rem">Section scores show up after you log a full-length.</p>
			{/if}
		</section>
	</div>

	<section class="card" id="heatmap" aria-labelledby="hm-h">
		<div class="card-header" style="align-items: flex-end">
			<div>
				<h2 id="hm-h">Strengths and weaknesses by AAMC category</h2>
				<div class="card-sub">
					Last 60 days. Each kind of evidence is shown on its own and never combined. Below {data.thresholds.recall} reviews or {data.thresholds.practice} questions a tile says “not enough data”.
				</div>
			</div>
			<div class="segmented" role="tablist" aria-label="Evidence">
				<button type="button" role="tab" aria-selected={evidence === 'recall'} onclick={() => (evidence = 'recall')}>Recall (cards)</button>
				<button type="button" role="tab" aria-selected={evidence === 'practice'} onclick={() => (evidence = 'practice')}>Practice</button>
				<button type="button" role="tab" aria-selected={evidence === 'fullLength'} onclick={() => (evidence = 'fullLength')}>Full-length</button>
			</div>
		</div>
		<div class="legend small" aria-label="Legend">
			{#if evidence === 'fullLength'}
				<span><span class="sw heat-3"></span>1 missed</span><span><span class="sw heat-2"></span>2</span><span><span class="sw heat-1"></span>3 or more</span>
				<span class="muted">Misses logged from your last {data.fl.list.slice(-5).length || 'few'} full-lengths</span>
			{:else}
				<span><span class="sw heat-1"></span>Under 62%</span><span><span class="sw heat-2"></span>62–69</span><span><span class="sw heat-3"></span>70–77</span>
				<span><span class="sw heat-4"></span>78–84</span><span><span class="sw heat-5"></span>85%+</span><span><span class="sw heat-none"></span>Not enough data</span>
			{/if}
		</div>
		<div class="stack" style="margin-top: 1rem; gap: 1.125rem">
			{#each data.heat as row (row.section)}
				<div class="heat-row">
					<div class="heat-name strong"><span class="sec-bar" data-sec={row.section}></span> {row.name}</div>
					<div class="heat-cells">
						{#each row.cells as c (c.code)}
							{@const ev = evidence === 'recall' ? c.recall : evidence === 'practice' ? c.practice : null}
							{#if ev}
								<a
									class="tile {heatClass(ev.value)}"
									href={evidence === 'recall' ? `/review?aamc=${c.code}` : `/mistakes?state=all&aamc=${c.code}`}
									title="{c.code} {c.name}: {ev.enough ? `${Math.round((ev.value ?? 0) * 100)}% of ${ev.n}` : `not enough data (${ev.n})`}{ev.last ? `, last ${shortDate(ev.last)}` : ''}"
								>
									<span class="mono tile-code">{c.code}</span>
									<span class="tile-val">{ev.enough && ev.value !== null ? `${Math.round(ev.value * 100)}%` : '—'}</span>
									<span class="tile-n">{ev.enough ? `n=${ev.n}` : ev.n ? `${ev.n} so far` : 'no data'}</span>
								</a>
							{:else}
								<a class="tile {c.fullLength.enough ? flClass(c.fullLength.missed) : 'heat-none'}" href="/mistakes?state=all&aamc={c.code}" title="{c.code} {c.name}">
									<span class="mono tile-code">{c.code}</span>
									<span class="tile-val">{c.fullLength.enough ? c.fullLength.missed : '—'}</span>
									<span class="tile-n">{c.fullLength.enough ? 'missed' : 'no exams'}</span>
								</a>
							{/if}
						{/each}
					</div>
				</div>
			{/each}
		</div>
	</section>

	<div class="columns" style="align-items: stretch">
		<section class="card" style="flex: 1 1 22rem; min-width: 0" aria-labelledby="mj-h">
			<h2 id="mj-h">Why you miss questions</h2>
			<div class="card-sub">From your mistake journal · {data.reasons.total} logged {data.range === 'all' ? 'in total' : `in the last ${data.range} days`}</div>
			{#if data.reasons.total}
				<div class="stack" style="margin-top: 1.125rem; gap: 0.875rem">
					{#each data.reasons.reasons as r (r.code)}
						<div>
							<div class="row" style="justify-content: space-between; font-size: 0.875rem">
								<span>{r.label}</span><span class="mono strong">{r.pct}% <span class="muted" style="font-weight: 500">({r.n})</span></span>
							</div>
							<div class="bar bar-lg navy" style="margin-top: 0.375rem"><span style="width: {data.reasons.reasons[0].n ? (r.n / data.reasons.reasons[0].n) * 100 : 0}%"></span></div>
						</div>
					{/each}
				</div>
			{:else}
				<p class="small muted" style="margin-top: 0.75rem">Log missed questions in the mistake journal to see patterns here.</p>
			{/if}
		</section>

		<section class="card" style="flex: 1 1 22rem; min-width: 0" aria-labelledby="st-h">
			<div class="card-header">
				<h2 id="st-h">Study time</h2>
				<span class="streak-chip small strong"><span class="flame"><Icon name="flame" size={15} /></span>{data.streak.current}-day streak</span>
			</div>
			<div class="card-sub">{weekly ? 'Hours per week' : 'Minutes per day'}{data.dailyGoal && !weekly ? ` · goal ${data.dailyGoal} min a day` : ''}</div>
			<div class="tbars" role="img" aria-label="Study time: {bars.map((b) => `${shortDate(b.label)} ${durationLabel(b.seconds)}`).join(', ')}">
				{#if data.dailyGoal && !weekly}
					<div class="goal-line" style="bottom: {((data.dailyGoal * 60) / barMax) * 100}%"></div>
				{/if}
				{#each bars as b (b.label)}
					<div class="tbar-col" title="{shortDate(b.label)}: {durationLabel(b.seconds)}">
						<div class="tbar" class:today={b.label === today} style="height: {Math.max(b.seconds ? 3 : 0, (b.seconds / barMax) * 100)}%"></div>
					</div>
				{/each}
			</div>
			<div class="row small muted" style="justify-content: space-between; margin-top: 0.375rem">
				<span>{bars.length ? shortDate(bars[0].label) : ''}</span>
				{#if bars.length <= 7}{#each bars as b (b.label)}<span>{weekdayShort(b.label)}</span>{/each}{/if}
				<span>{bars.length ? (weekly ? 'this week' : 'today') : ''}</span>
			</div>
			<div class="totals">
				<div><div class="tiny muted">Study time</div><div class="mono strong t-num">{durationLabel(totalSeconds)}</div></div>
				<div><div class="tiny muted">Cards reviewed</div><div class="mono strong t-num">{data.reviewsInRange.toLocaleString()}</div></div>
				<div><div class="tiny muted">Retention</div><div class="mono strong t-num">{data.retention.rate === null ? '—' : `${Math.round(data.retention.rate * 100)}%`}</div></div>
				<div><div class="tiny muted">Questions logged</div><div class="mono strong t-num">{data.practiced}</div></div>
			</div>
		</section>
	</div>

	<section class="card stack" aria-labelledby="pr-h">
		<div class="card-header">
			<div>
				<h2 id="pr-h">Practice questions</h2>
				<div class="card-sub">Log sets from question banks (UWorld, AAMC packs…). They feed the Practice evidence above.</div>
			</div>
			<button type="button" class="btn btn-sm" onclick={() => (practiceOpen = true)}><Icon name="plus" size={16} />Log practice</button>
		</div>
		{#if data.practiceSets.length}
			<div class="table-wrap">
				<table class="table">
					<thead><tr><th>Date</th><th>Source</th><th>Topic</th><th>Score</th><th>Time</th><th><span class="sr-only">Actions</span></th></tr></thead>
					<tbody>
						{#each data.practiceSets as p (p.id)}
							<tr>
								<td class="nowrap">{shortDate(p.date)}</td>
								<td>{p.source}</td>
								<td>{p.aamcCode ?? p.skillCode ?? p.section ?? 'Mixed'}</td>
								<td class="mono">{p.correct}/{p.total} · {Math.round((p.correct / p.total) * 100)}%</td>
								<td class="mono">{p.minutes ? `${p.minutes}m` : ''}</td>
								<td>
									<form method="POST" action="?/deletePractice" use:enhance>
										<input type="hidden" name="id" value={p.id} />
										<button class="icon-btn plain" aria-label="Delete practice set"><Icon name="trash" size={16} /></button>
									</form>
								</td>
							</tr>
						{/each}
					</tbody>
				</table>
			</div>
		{/if}
	</section>
</div>

<FlImportDialog bind:open={importOpen} today={data.today} />

<Modal bind:open={flOpen} title="Log a full-length">
	<form id="fl-form" method="POST" action="?/fullLength" class="stack" use:enhance={onSaved(() => (flOpen = false), 'Full-length logged')}>
		<div class="form-grid">
			<div class="field"><label for="fl-date">Date taken</label><input id="fl-date" name="date" type="date" class="input" value={today} required /></div>
			<div class="field">
				<label for="fl-provider">Made by</label>
				<select id="fl-provider" name="provider" class="select">{#each FULL_LENGTH_PROVIDERS as p (p)}<option>{p}</option>{/each}</select>
			</div>
			<div class="field"><label for="fl-form-name">Exam</label><input id="fl-form-name" name="form" class="input" placeholder="e.g. Sample Test, FL 3" /></div>
		</div>
		<div class="form-grid">
			<div class="field"><label for="fl-cp">Chem/Phys</label><input id="fl-cp" name="cp" type="number" min="118" max="132" class="input mono" /></div>
			<div class="field"><label for="fl-cars">CARS</label><input id="fl-cars" name="cars" type="number" min="118" max="132" class="input mono" /></div>
			<div class="field"><label for="fl-bb">Bio/Biochem</label><input id="fl-bb" name="bb" type="number" min="118" max="132" class="input mono" /></div>
			<div class="field"><label for="fl-ps">Psych/Soc</label><input id="fl-ps" name="ps" type="number" min="118" max="132" class="input mono" /></div>
		</div>
		<div class="field" style="max-width: 12rem"><label for="fl-total">Total</label><input id="fl-total" name="total" type="number" min="472" max="528" class="input mono" /><span class="hint">Filled in from the sections when all four are entered.</span></div>
		<div class="field"><label for="fl-notes">Notes</label><textarea id="fl-notes" name="notes" class="textarea" rows="3" placeholder="Timing, focus, what felt hard"></textarea></div>
		{#if form && 'error' in form && form.form === 'fullLength'}<div class="error-box" role="alert"><Icon name="alert" size={18} />{form.error}</div>{/if}
	</form>
	{#snippet footer()}
		<button type="button" class="btn" onclick={() => (flOpen = false)}>Cancel</button>
		<button type="submit" form="fl-form" class="btn btn-primary">Save</button>
	{/snippet}
</Modal>

<Modal bind:open={practiceOpen} title="Log practice questions">
	<form id="pr-form" method="POST" action="?/practice" class="stack" use:enhance={onSaved(() => (practiceOpen = false), 'Practice logged')}>
		<div class="form-grid">
			<div class="field"><label for="pr-date">Date</label><input id="pr-date" name="date" type="date" class="input" value={today} required /></div>
			<div class="field">
				<label for="pr-source">Source</label>
				<select id="pr-source" name="source" class="select">{#each PRACTICE_SOURCES as s (s)}<option>{s}</option>{/each}</select>
			</div>
			<div class="field">
				<label for="pr-section">Section</label>
				<select id="pr-section" name="section" class="select">
					<option value="">Mixed</option><option value="CP">Chem/Phys</option><option value="CARS">CARS</option><option value="BB">Bio/Biochem</option><option value="PS">Psych/Soc</option>
				</select>
			</div>
		</div>
		<div class="form-grid">
			<div class="field">
				<label for="pr-cat">AAMC category <span class="muted">(if one topic)</span></label>
				<CategorySelect id="pr-cat" bind:value={practiceCode} />
				<input type="hidden" name="aamcCode" value={practiceCode ?? ''} />
			</div>
			<div class="field">
				<label for="pr-skill">Reasoning skill <span class="muted">(optional)</span></label>
				<select id="pr-skill" name="skillCode" class="select">
					<option value="">None</option>
					{#each SKILLS as s (s.code)}<option value={s.code}>{s.code}: {s.name}</option>{/each}
				</select>
			</div>
		</div>
		<div class="form-grid">
			<div class="field"><label for="pr-total">Questions</label><input id="pr-total" name="total" type="number" min="1" class="input mono" required /></div>
			<div class="field"><label for="pr-correct">Correct</label><input id="pr-correct" name="correct" type="number" min="0" class="input mono" required /></div>
			<div class="field"><label for="pr-min">Minutes <span class="muted">(optional)</span></label><input id="pr-min" name="minutes" type="number" min="0" class="input mono" /></div>
		</div>
		<div class="field"><label for="pr-notes">Notes</label><textarea id="pr-notes" name="notes" class="textarea" rows="2"></textarea></div>
		<p class="hint">Log the questions you missed in the mistake journal to see why.</p>
		{#if form && 'error' in form && form.form === 'practice'}<div class="error-box" role="alert"><Icon name="alert" size={18} />{form.error}</div>{/if}
	</form>
	{#snippet footer()}
		<button type="button" class="btn" onclick={() => (practiceOpen = false)}>Cancel</button>
		<button type="submit" form="pr-form" class="btn btn-primary">Save</button>
	{/snippet}
</Modal>

<style>
	.fl-chart {
		display: block;
		margin-top: 0.75rem;
		font-family: var(--font-ui);
	}
	.fl-chart .grid {
		stroke: var(--border);
	}
	.fl-chart .axis {
		stroke: var(--border-strong);
	}
	.fl-chart .tick {
		font-size: 12px;
		fill: var(--text-3);
	}
	.fl-chart .goal {
		stroke: var(--accent-text);
		stroke-width: 1.5;
		stroke-dasharray: 5 5;
	}
	.fl-chart .goal-label {
		font-size: 12px;
		font-weight: 600;
		fill: var(--accent-text);
	}
	.fl-chart .line {
		fill: none;
		stroke: var(--accent);
		stroke-width: 2;
		stroke-linejoin: round;
		stroke-linecap: round;
	}
	.fl-chart .dot {
		fill: var(--accent);
		stroke: var(--surface);
		stroke-width: 2;
		cursor: pointer;
	}
	.fl-chart .val {
		font-size: 13px;
		font-weight: 700;
		fill: var(--text);
	}
	.legend {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem 0.875rem;
		margin-top: 0.875rem;
		color: var(--text-2);
	}
	.legend > span {
		display: inline-flex;
		align-items: center;
		gap: 5px;
	}
	.sw {
		width: 14px;
		height: 14px;
		border-radius: 3px;
		display: inline-block;
	}
	.heat-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
	}
	.heat-name {
		flex: 0 0 8.5rem;
		font-size: 0.875rem;
	}
	.heat-cells {
		flex: 1 1 25rem;
		min-width: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(4.75rem, 1fr));
		gap: 6px;
	}
	.tile {
		min-height: 64px;
		border-radius: 8px;
		color: var(--heat-text);
		text-decoration: none;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 1px;
		padding: 6px;
	}
	.tile:hover {
		outline: 2px solid var(--accent);
		color: var(--heat-text);
		text-decoration: none;
	}
	.tile.heat-none,
	.tile.heat-none:hover {
		color: var(--text-3);
	}
	.tile-code {
		font-size: 0.75rem;
		font-weight: 600;
	}
	.tile-val {
		font-size: 0.875rem;
		font-weight: 700;
	}
	.tile-n {
		font-size: 0.625rem;
		opacity: 0.85;
	}
	.heat-1 {
		background: var(--heat-1);
	}
	.heat-2 {
		background: var(--heat-2);
	}
	.heat-3 {
		background: var(--heat-3);
	}
	.heat-4 {
		background: var(--heat-4);
	}
	.heat-5 {
		background: var(--heat-5);
	}
	/* Not enough data: an empty tile, dashed. */
	.heat-none {
		background: transparent;
		border: 1px dashed var(--border-strong);
	}
	.streak-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		padding: 0.25rem 0.625rem;
		border-radius: 999px;
		background: var(--surface-2);
		border: 1px solid var(--border);
		color: var(--text-2);
	}
	.flame {
		display: inline-flex;
		color: var(--accent);
	}
	.tbars {
		position: relative;
		display: flex;
		align-items: flex-end;
		gap: 3px;
		height: 120px;
		margin-top: 1rem;
		border-bottom: 1px solid var(--border-strong);
	}
	.tbar-col {
		flex: 1 1 0;
		height: 100%;
		display: flex;
		align-items: flex-end;
	}
	.tbar {
		width: 100%;
		border-radius: 3px 3px 0 0;
		background: var(--accent-muted);
	}
	.tbar.today {
		background: var(--accent);
	}
	.goal-line {
		position: absolute;
		left: 0;
		right: 0;
		border-top: 1.5px dashed var(--accent-text);
		pointer-events: none;
	}
	.totals {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(7rem, 1fr));
		gap: 0.75rem;
		margin-top: 1.125rem;
	}
	.t-num {
		font-size: 1.25rem;
	}
</style>
