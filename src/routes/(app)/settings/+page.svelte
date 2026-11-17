<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { appearance, setAccountAppearance } from '#lib/client/appearance.svelte.js';
	import { toast } from '#lib/client/toast.svelte.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let zones = $state<string[]>([]);
	const s = $derived(data.settings);
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

<svelte:head><title>Settings · Medicus Vitae</title></svelte:head>

<form
	method="POST"
	action="?/save"
	class="stack"
	use:enhance={() => async ({ result, update }) => {
		await update({ reset: false });
		if (result.type === 'success') {
			toast('Settings saved');
			await invalidate('app:shell');
		}
	}}
>
	<section class="card stack">
		<h2>Your target</h2>
		<div class="form-grid">
			<div class="field"><label for="displayName">First name</label><input id="displayName" name="displayName" class="input" value={s.displayName} /></div>
			<div class="field"><label for="testDate">Test date</label><input id="testDate" name="testDate" type="date" class="input" value={s.testDate ?? ''} /></div>
			<div class="field"><label for="goalScore">Goal score</label><input id="goalScore" name="goalScore" type="number" min="472" max="528" class="input mono" value={s.goalScore ?? ''} /></div>
			<div class="field"><label for="weeklyHours">Hours per week</label><input id="weeklyHours" name="weeklyHours" type="number" min="1" max="100" step="0.5" class="input mono" value={s.weeklyHours ?? ''} /></div>
		</div>
		<label class="checkbox" style="margin-top: -0.5rem">
			<input type="checkbox" checked={appearance.account.showTestDay} onchange={(e) => setAccountAppearance({ showTestDay: (e.currentTarget as HTMLInputElement).checked })} />
			Show the test-day countdown in the menu
		</label>
		<fieldset class="field" style="border: 0; padding: 0; margin: 0">
			<legend class="label" style="margin-bottom: 0.375rem">Study days</legend>
			<div class="row-tight">
				{#each days as d (d.v)}
					<label class="checkbox" style="min-height: 36px; margin-right: 0.5rem"><input type="checkbox" name="studyDays" value={d.v} checked={s.studyDays.includes(d.v)} />{d.l}</label>
				{/each}
			</div>
			<span class="hint">Your daily goal is your weekly hours spread over these days.</span>
		</fieldset>
	</section>

	<section class="card stack">
		<h2>Study days and cards</h2>
		<div class="form-grid">
			<div class="field">
				<label for="dayStartHour">A new study day starts at</label>
				<select id="dayStartHour" name="dayStartHour" class="select">
					{#each Array.from({ length: 13 }, (_, h) => h) as h (h)}
						<option value={h} selected={h === s.dayStartHour}>{h === 0 ? 'Midnight' : h === 12 ? 'Noon' : `${h} a.m.`}</option>
					{/each}
				</select>
				<span class="hint">Reviews after midnight but before this hour count toward the previous day, so late nights don’t break your streak.</span>
			</div>
			<div class="field">
				<label for="timeZone">Time zone</label>
				<select id="timeZone" name="timeZone" class="select">
					{#each zones.length ? zones : [s.timeZone] as z (z)}<option value={z} selected={z === s.timeZone}>{z.replace(/_/g, ' ')}</option>{/each}
				</select>
			</div>
			<div class="field">
				<label for="newCardsPerDay">New cards per day</label>
				<input id="newCardsPerDay" name="newCardsPerDay" type="number" min="0" max="9999" class="input mono" value={s.newCardsPerDay} />
				<span class="hint">New cards beyond this wait until tomorrow. The review forecast on Today shows the effect.</span>
			</div>
			<div class="field">
				<label for="desiredRetention">Desired retention (%)</label>
				<input id="desiredRetention" name="desiredRetention" type="number" min="70" max="99" class="input mono" value={Math.round(s.desiredRetention * 100)} />
				<span class="hint">FSRS schedules each card so you have this chance of remembering it. 90% is the usual choice; higher means more reviews.</span>
			</div>
			<div class="field">
				<label for="leechThreshold">Flag a card as a leech after it’s forgotten</label>
				<div class="row-tight"><input id="leechThreshold" name="leechThreshold" type="number" min="3" max="99" class="input mono" style="width: 6rem" value={s.leechThreshold} /><span class="small muted">times</span></div>
				<span class="hint">Leeches are only flagged for you to rewrite or split; they keep their schedule and aren’t suspended.</span>
			</div>
		</div>
	</section>

	{#if form?.error}<div class="error-box" role="alert"><Icon name="alert" size={18} />{form.error}</div>{/if}
	<div><button class="btn btn-primary">Save settings</button></div>
</form>
