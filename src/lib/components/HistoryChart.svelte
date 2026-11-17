<script lang="ts">
	import { durationLabel, shortDate, weekdayShort } from '#lib/dates.js';

	// Study time per day (one series, so no legend: the card's title names it).
	// Thin bars anchored to the baseline, a label on today and the best day, a
	// tooltip on every bar (hover or keyboard), and a table for screen readers.

	let { days, today }: { days: { day: string; seconds: number; reviews: number; passed: number }[]; today: string } = $props();

	const max = $derived(Math.max(60, ...days.map((d) => d.seconds)));
	const best = $derived(days.reduce((m, d) => (d.seconds > m.seconds ? d : m), days[0]));
	const total = $derived(days.reduce((a, d) => a + d.seconds, 0));
	const active = $derived(days.filter((d) => d.seconds >= 300 || d.reviews > 0).length);
	let hover = $state<number | null>(null);
	let showTable = $state(false);

	const label = (d: (typeof days)[number]) =>
		`${weekdayShort(d.day)} ${shortDate(d.day)}: ${d.seconds ? durationLabel(d.seconds, 'long') : 'no study time'}${d.reviews ? `, ${d.reviews} card${d.reviews === 1 ? '' : 's'} (${Math.round((d.passed / d.reviews) * 100)}% remembered)` : ''}`;
</script>

<div class="hist">
	<div class="hist-sum small muted">
		<span><span class="mono strong" style="color: var(--text)">{durationLabel(total)}</span> in {days.length} days</span>
		<span>Studied on <span class="mono strong" style="color: var(--text)">{active}</span> of them</span>
		<button type="button" class="link-btn" aria-pressed={showTable} onclick={() => (showTable = !showTable)}>{showTable ? 'Chart' : 'Table'}</button>
	</div>
	{#if showTable}
		<div class="table-wrap">
			<table class="table small">
				<thead><tr><th>Day</th><th>Study time</th><th>Cards</th><th>Remembered</th></tr></thead>
				<tbody>
					{#each [...days].reverse() as d (d.day)}
						<tr><td>{weekdayShort(d.day)} {shortDate(d.day)}</td><td class="mono">{durationLabel(d.seconds)}</td><td class="mono">{d.reviews}</td><td class="mono">{d.reviews ? `${Math.round((d.passed / d.reviews) * 100)}%` : '—'}</td></tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<div class="plot" role="group" aria-label="Study time per day, last {days.length} days" onmouseleave={() => (hover = null)}>
			{#each days as d, i (d.day)}
				{@const h = d.seconds ? Math.max(4, Math.round((d.seconds / max) * 112)) : 0}
				<button
					type="button"
					class="col"
					aria-label={label(d)}
					onmouseenter={() => (hover = i)}
					onfocus={() => (hover = i)}
					onblur={() => (hover = null)}
				>
					{#if d.day === today || (d === best && d.seconds > 0)}
						<span class="val mono">{d.seconds < 60 ? (d.seconds ? '<1m' : '0m') : `${Math.round(d.seconds / 60)}m`}</span>
					{/if}
					<span class="bar-mark" class:today={d.day === today} class:hot={hover === i} style:height="{h}px"></span>
					{#if !d.seconds}<span class="zero"></span>{/if}
					{#if hover === i}
						<span class="tip" class:left={i > days.length / 2} role="tooltip">
							<strong>{weekdayShort(d.day)} {shortDate(d.day)}</strong>
							<span>{d.seconds ? durationLabel(d.seconds, 'long') : 'No study time'}</span>
							{#if d.reviews}<span>{d.reviews} cards · {Math.round((d.passed / d.reviews) * 100)}% remembered</span>{/if}
						</span>
					{/if}
				</button>
			{/each}
		</div>
		<div class="axis">
			{#each days as d, i (d.day)}
				<span class:strong={d.day === today}>{i === days.length - 1 ? 'Today' : i % 2 === (days.length - 1) % 2 ? weekdayShort(d.day).slice(0, 2) : ''}</span>
			{/each}
		</div>
	{/if}
</div>

<style>
	.hist-sum {
		display: flex;
		flex-wrap: wrap;
		gap: 0.375rem 1rem;
		align-items: baseline;
	}
	.hist-sum .link-btn {
		margin-left: auto;
	}
	.plot {
		display: flex;
		align-items: flex-end;
		gap: 2px;
		height: 136px;
		margin-top: 0.75rem;
		border-bottom: 1px solid var(--border-strong);
	}
	.col {
		position: relative;
		flex: 1 1 0;
		height: 100%;
		display: flex;
		flex-direction: column;
		justify-content: flex-end;
		align-items: center;
		gap: 3px;
		outline-offset: 1px;
		cursor: default;
		border: 0;
		background: none;
		padding: 0;
		color: inherit;
		font: inherit;
	}
	.bar-mark {
		width: 100%;
		max-width: 22px;
		border-radius: 4px 4px 0 0;
		background: var(--accent-muted);
		transition: background-color 0.1s;
	}
	.bar-mark.today,
	.bar-mark.hot {
		background: var(--accent);
	}
	.zero {
		width: 6px;
		height: 2px;
		border-radius: 1px;
		background: var(--border-strong);
	}
	.val {
		font-size: 0.6875rem;
		font-weight: 600;
		color: var(--text-2);
	}
	.tip {
		position: absolute;
		bottom: calc(100% - 8px);
		left: 50%;
		z-index: 5;
		display: flex;
		flex-direction: column;
		gap: 1px;
		white-space: nowrap;
		padding: 0.375rem 0.625rem;
		border-radius: var(--radius-sm);
		background: var(--ink);
		color: var(--on-ink);
		font-size: 0.75rem;
		box-shadow: var(--shadow-lg);
		pointer-events: none;
	}
	.tip.left {
		left: auto;
		right: 50%;
	}
	.axis {
		display: flex;
		gap: 2px;
		padding-top: 6px;
		font-size: 0.6875rem;
		color: var(--text-3);
	}
	.axis span {
		flex: 1 1 0;
		text-align: center;
		white-space: nowrap;
	}
	.axis .strong {
		color: var(--text);
	}
	.link-btn {
		border: 0;
		background: none;
		padding: 0;
		color: var(--accent-text);
		font: inherit;
		font-weight: 600;
		cursor: pointer;
		text-decoration: underline;
	}
</style>
