<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import BookUploader from '#lib/components/BookUploader.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const labels: Record<string, string> = {
		target: 'Your target',
		baseline: 'Starting point',
		content: 'Bring your books',
		ai: 'Connect AI'
	};
	const index = $derived(data.steps.indexOf(data.step));
	const next = $derived(data.steps[index + 1] ?? null);

	let zones = $state<string[]>([]);
	let kind = $state<'diagnostic' | 'confidence' | ''>('');
	let uploaded = $state(0);

	onMount(() => {
		try {
			zones = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
		} catch {
			zones = [data.settings.timeZone];
		}
	});

	const days = [
		{ v: 1, l: 'Mon' },
		{ v: 2, l: 'Tue' },
		{ v: 3, l: 'Wed' },
		{ v: 4, l: 'Thu' },
		{ v: 5, l: 'Fri' },
		{ v: 6, l: 'Sat' },
		{ v: 0, l: 'Sun' }
	];
</script>

<svelte:head><title>Get set up · Medicus Vitae</title></svelte:head>

<div class="card auth-card wide stack">
	<ol class="steps" aria-label="Setup steps">
		{#each data.steps as s, i (s)}
			<li aria-current={s === data.step ? 'step' : undefined} class:done={i < index}>
				<span class="dot mono">{i < index ? '✓' : i + 1}</span>{labels[s]}
			</li>
		{/each}
	</ol>

	{#if data.step === 'target'}
		<div>
			<h1 style="font-size: 1.5rem">Set your target</h1>
			<p class="muted" style="margin-top: 0.25rem">This sets your countdown, daily goal and when a study day ends. All optional.</p>
		</div>
		<form method="POST" action="?/target" class="stack" use:enhance>
			<div class="form-grid">
				<div class="field">
					<label for="testDate">Test date</label>
					<input id="testDate" name="testDate" type="date" class="input" value={data.settings.testDate ?? ''} />
				</div>
				<div class="field">
					<label for="goalScore">Goal score</label>
					<input id="goalScore" name="goalScore" type="number" min="472" max="528" class="input mono" placeholder="515" value={data.settings.goalScore ?? ''} />
				</div>
				<div class="field">
					<label for="weeklyHours">Hours per week</label>
					<input id="weeklyHours" name="weeklyHours" type="number" min="1" max="100" step="0.5" class="input mono" placeholder="20" value={data.settings.weeklyHours ?? ''} />
				</div>
			</div>
			<fieldset class="field" style="border: 0; padding: 0; margin: 0">
				<legend class="label" style="margin-bottom: 0.375rem">Study days</legend>
				<div class="row-tight">
					{#each days as d (d.v)}
						<label class="day-chip">
							<input type="checkbox" name="studyDays" value={d.v} checked={data.settings.studyDays.includes(d.v)} />
							<span>{d.l}</span>
						</label>
					{/each}
				</div>
			</fieldset>
			<div class="form-grid">
				<div class="field">
					<label for="dayStartHour">A new study day starts at</label>
					<select id="dayStartHour" name="dayStartHour" class="select">
						{#each Array.from({ length: 13 }, (_, h) => h) as h (h)}
							<option value={h} selected={h === data.settings.dayStartHour}>
								{h === 0 ? 'Midnight' : h === 12 ? 'Noon' : `${h} a.m.`}
							</option>
						{/each}
					</select>
					<span class="hint">Reviews after midnight but before this count toward the previous day.</span>
				</div>
				<div class="field">
					<label for="timeZone">Time zone</label>
					<select id="timeZone" name="timeZone" class="select">
						{#each zones.length ? zones : [data.settings.timeZone] as z (z)}
							<option value={z} selected={z === data.settings.timeZone}>{z.replace(/_/g, ' ')}</option>
						{/each}
					</select>
				</div>
			</div>
			{#if form?.error}<div class="error-box" role="alert"><Icon name="alert" size={18} />{form.error}</div>{/if}
			<div class="form-actions">
				<button class="btn btn-primary">Save and continue</button>
				<a class="btn btn-ghost" href="/welcome?step={next}">Skip for now</a>
			</div>
		</form>
	{:else if data.step === 'baseline'}
		<div>
			<h1 style="font-size: 1.5rem">Where are you starting?</h1>
			<p class="muted" style="margin-top: 0.25rem">Optional. Log a diagnostic score, or rate your confidence per section.</p>
		</div>
		<form method="POST" action="?/baseline" class="stack" use:enhance>
			<div class="segmented" role="radiogroup" aria-label="Baseline type">
				<label class="seg-radio"><input type="radio" name="kind" value="diagnostic" bind:group={kind} />Diagnostic score</label>
				<label class="seg-radio"><input type="radio" name="kind" value="confidence" bind:group={kind} />Confidence 1–5</label>
			</div>
			{#if kind === 'diagnostic'}
				<div class="form-grid">
					<div class="field"><label for="date">Date taken</label><input id="date" name="date" type="date" class="input" /></div>
					<div class="field"><label for="total">Total (472–528)</label><input id="total" name="total" type="number" min="472" max="528" class="input mono" /></div>
				</div>
				<div class="form-grid">
					<div class="field"><label for="cp">Chem/Phys</label><input id="cp" name="cp" type="number" min="118" max="132" class="input mono" /></div>
					<div class="field"><label for="cars">CARS</label><input id="cars" name="cars" type="number" min="118" max="132" class="input mono" /></div>
					<div class="field"><label for="bb">Bio/Biochem</label><input id="bb" name="bb" type="number" min="118" max="132" class="input mono" /></div>
					<div class="field"><label for="ps">Psych/Soc</label><input id="ps" name="ps" type="number" min="118" max="132" class="input mono" /></div>
				</div>
				<p class="hint">Enter all four sections and the total is added up for you.</p>
			{:else if kind === 'confidence'}
				<div class="stack-sm">
					{#each [['cp', 'Chem/Phys'], ['cars', 'CARS'], ['bb', 'Bio/Biochem'], ['ps', 'Psych/Soc']] as [k, l] (k)}
						<fieldset class="conf-row">
							<legend class="strong">{l}</legend>
							<div class="row-tight">
								{#each [1, 2, 3, 4, 5] as n (n)}
									<label class="day-chip"><input type="radio" name={k} value={n} /><span>{n}</span></label>
								{/each}
							</div>
						</fieldset>
					{/each}
					<p class="hint">1 = not confident at all, 5 = very confident.</p>
				</div>
			{/if}
			{#if form?.error}<div class="error-box" role="alert"><Icon name="alert" size={18} />{form.error}</div>{/if}
			<div class="form-actions">
				<button class="btn btn-primary" disabled={!kind}>Save and continue</button>
				<a class="btn btn-ghost" href="/welcome?step=content">Skip for now</a>
			</div>
		</form>
	{:else if data.step === 'content'}
		<div>
			<h1 style="font-size: 1.5rem">Bring your books</h1>
			<p class="muted" style="margin-top: 0.25rem">Import the PDFs you study from, or start empty and add them from the Library later.</p>
		</div>
		<BookUploader onuploaded={(ids) => (uploaded += ids.length)} />
		<div class="row small">
			<Icon name="cards" size={18} />
			<span>Using Anki? You can bring a deck in (cards, images and review history) once setup is done.</span>
		</div>
		<div class="form-actions">
			<a class="btn btn-primary btn-lg" href="/welcome?step=ai">{uploaded ? 'Continue' : 'Continue without books'}</a>
			<form method="POST" action="?/finish" use:enhance>
				<input type="hidden" name="next" value="anki" />
				<button class="btn btn-lg">Finish and import an Anki deck</button>
			</form>
		</div>
	{:else}
		<div>
			<h1 style="font-size: 1.5rem">Connect AI (optional)</h1>
			<p class="muted" style="margin-top: 0.25rem">
				The tutor answers questions from your own books, notes and cards, with sources, and can draft cards and quiz questions for you to approve. Use your Claude plan through Claude Code on this computer, sign in with your ChatGPT plan, or add a Claude or OpenAI API key. Everything else works without AI.
			</p>
		</div>
		<div class="form-actions">
			<form method="POST" action="?/finish" use:enhance>
				<input type="hidden" name="next" value="ai" />
				<button class="btn btn-navy btn-lg"><Icon name="sparkle" size={18} />Connect AI</button>
			</form>
			<form method="POST" action="?/finish" use:enhance>
				<button class="btn btn-lg">Skip, go to Today</button>
			</form>
		</div>
	{/if}
</div>

<style>
	.steps {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem 1.25rem;
		font-size: 0.8125rem;
		color: var(--text-3);
		font-weight: 600;
	}
	.steps li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.steps li[aria-current='step'] {
		color: var(--text);
	}
	.dot {
		width: 1.5rem;
		height: 1.5rem;
		border-radius: 999px;
		background: var(--surface-2);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-size: 0.75rem;
	}
	.steps li[aria-current='step'] .dot {
		background: var(--accent);
		color: var(--on-accent);
	}
	.steps li.done .dot {
		background: var(--accent-soft);
		color: var(--accent-text);
	}
	.day-chip {
		position: relative;
		cursor: pointer;
	}
	.day-chip input {
		position: absolute;
		opacity: 0;
		inset: 0;
		cursor: pointer;
	}
	.day-chip span {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 44px;
		min-height: 44px;
		padding: 0 0.75rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		font-weight: 600;
		font-size: 0.875rem;
	}
	.day-chip input:checked + span {
		background: var(--ink);
		border-color: var(--ink);
		color: var(--on-ink);
	}
	.day-chip input:focus-visible + span {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}
	.seg-radio {
		min-height: 38px;
		padding: 0 0.875rem;
		border-radius: var(--radius-sm);
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		font-size: 0.875rem;
		font-weight: 600;
		cursor: pointer;
	}
	.seg-radio:has(input:checked) {
		background: var(--surface);
		box-shadow: var(--shadow);
	}
	.seg-radio input {
		accent-color: var(--accent);
	}
	.conf-row {
		border: 0;
		margin: 0;
		padding: 0;
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.75rem;
	}
	.conf-row legend {
		float: left;
		width: 8rem;
		padding: 0;
	}
</style>
