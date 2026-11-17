<script lang="ts">
	import { onMount } from 'svelte';
	import { appearance } from '#lib/client/appearance.svelte.js';
	import { unlockAudio } from '#lib/client/chime.js';
	import { currentItem, live, liveTimeLeft, timer, wallClock } from '#lib/client/session.svelte.js';
	import { BREATH_PATTERNS, clockLabel, MEDITATIONS, PROMPTS, type BreakActivity, type PromptKind } from '#lib/focus.js';
	import Icon from './Icon.svelte';

	// The calm screen between focus rounds: a breathing guide, gentle reminders
	// (relax, rest your eyes, water, stretch) and a short guided meditation, as
	// chosen in Settings › Focus & breaks. Also asks "ready?" between phases when
	// the next one doesn't start by itself.

	const t = $derived(live.plan?.timer ?? null);
	const prefs = $derived(live.prefs);
	const show = $derived(!!t && !live.breakHidden && (t.phase === 'break' || t.phase === 'ready-break' || t.phase === 'ready-focus'));
	const left = $derived(liveTimeLeft());
	const long = $derived(t?.breakKind === 'long');

	const activities = $derived(
		(
			[
				['breathing', 'Breathe', prefs.breathing],
				['prompts', 'Relax', prefs.prompts],
				['meditation', 'Meditate', prefs.meditation]
			] as [Exclude<BreakActivity, 'mix'>, string, boolean][]
		).filter((a) => a[2])
	);
	let activity = $state<Exclude<BreakActivity, 'mix'> | null>(null);
	const shown = $derived(
		activity && activities.some((a) => a[0] === activity)
			? activity
			: prefs.breakActivity !== 'mix' && activities.some((a) => a[0] === prefs.breakActivity)
				? (prefs.breakActivity as Exclude<BreakActivity, 'mix'>)
				: (activities[0]?.[0] ?? null)
	);

	// A fresh start for every break.
	let lastBreak = 0;
	$effect(() => {
		if (t && t.phase === 'break' && t.phaseStartedAt !== lastBreak) {
			lastBreak = t.phaseStartedAt;
			activity = null;
			stepStart = Date.now();
			medStep = 0;
			medStart = Date.now();
		}
	});

	// ---- breathing: which step of the pattern we're in, from the clock.
	let patternId = $state<string | null>(null);
	const pattern = $derived(BREATH_PATTERNS.find((p) => p.id === (patternId ?? prefs.breathPattern)) ?? BREATH_PATTERNS[0]);
	let stepStart = $state(Date.now());
	const cycle = $derived(pattern.steps.reduce((a, s) => a + s.seconds, 0));
	const breath = $derived.by(() => {
		const into = (((live.now - stepStart) / 1000) % cycle + cycle) % cycle;
		let acc = 0;
		for (const s of pattern.steps) {
			if (into < acc + s.seconds) return { step: s, left: Math.ceil(acc + s.seconds - into) };
			acc += s.seconds;
		}
		return { step: pattern.steps[0], left: pattern.steps[0].seconds };
	});

	// ---- calm prompts: one every 15 seconds from the kinds that are on.
	const promptList = $derived(
		(Object.keys(PROMPTS) as PromptKind[]).filter((k) => prefs.promptKinds[k]).flatMap((k) => PROMPTS[k])
	);
	const prompt = $derived(promptList.length ? promptList[Math.floor((live.now - (t?.phaseStartedAt ?? 0)) / 15000) % promptList.length] : '');

	// ---- meditation: steps move on by themselves (or with the buttons).
	let medId = $state<string | null>(null);
	const med = $derived(MEDITATIONS.find((m) => m.id === (medId ?? prefs.meditationScript)) ?? MEDITATIONS[0]);
	let medStep = $state(0);
	let medStart = $state(Date.now());
	const medStepSeconds = $derived(Math.max(10, Math.min(25, Math.floor((t?.phaseSeconds ?? 300) / (med.steps.length + 1)))));
	$effect(() => {
		if (shown === 'meditation' && live.now - medStart > medStepSeconds * 1000 && medStep < med.steps.length - 1) {
			medStep++;
			medStart = live.now;
		}
	});

	const reduced = $derived(appearance.device.reduceMotion);
	let mqReduced = $state(false);
	onMount(() => {
		const mq = matchMedia('(prefers-reduced-motion: reduce)');
		mqReduced = mq.matches;
		const on = () => (mqReduced = mq.matches);
		mq.addEventListener('change', on);
		const onKey = (e: KeyboardEvent) => {
			if (show && e.key === 'Escape') live.breakHidden = true;
		};
		window.addEventListener('keydown', onKey);
		return () => {
			mq.removeEventListener('change', on);
			window.removeEventListener('keydown', onKey);
		};
	});
	const still = $derived(reduced || mqReduced);

	const roundsDone = $derived(t?.rounds ?? 0);
	const item = $derived(currentItem());
</script>

{#if show && t}
	<div class="break-screen" role="dialog" aria-modal="true" aria-labelledby="break-title">
		<div class="break-inner">
			<div class="break-top">
				<span class="tiny muted">{wallClock(live.now, prefs.clock)}</span>
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => (live.breakHidden = true)} title="Put this away (Esc). The timer keeps going.">
					<Icon name="chevron-down" size={16} />Hide
				</button>
			</div>

			{#if t.phase === 'ready-break'}
				<div class="center stack">
					<div class="big-icon"><Icon name="check" size={34} stroke={2.5} /></div>
					<h2 id="break-title">Round {roundsDone} done. Nice work.</h2>
					<p class="muted">Time for a {long ? 'longer' : 'short'} break: {Math.round(t.phaseSeconds / 60)} minutes.</p>
					<div class="row" style="justify-content: center">
						<button type="button" class="btn btn-primary btn-lg" onclick={() => (unlockAudio(), timer('start'))}>Start break</button>
						<button type="button" class="btn" onclick={() => timer('skip')}>Skip the break</button>
					</div>
				</div>
			{:else if t.phase === 'ready-focus'}
				<div class="center stack">
					<div class="big-icon"><Icon name="play" size={30} /></div>
					<h2 id="break-title">Break’s over. Ready for round {roundsDone + 1}?</h2>
					{#if item}<p class="muted">Up next: <strong style="color: var(--text)">{item.title}</strong></p>{/if}
					<div class="row" style="justify-content: center">
						<button type="button" class="btn btn-primary btn-lg" onclick={() => (unlockAudio(), timer('start'))}>Start focusing</button>
						<button type="button" class="btn" onclick={() => (live.breakHidden = true)}>Not yet</button>
					</div>
				</div>
			{:else}
				<div class="center">
					<div class="eyebrow">{long ? 'Long break' : 'Short break'} · after round {roundsDone}</div>
					<h2 id="break-title" class="sr-only">Break</h2>
					<div class="break-time mono" aria-live="off">{clockLabel(left)}</div>
				</div>

				{#if activities.length > 1}
					<div class="segmented" role="tablist" aria-label="Break activity" style="align-self: center">
						{#each activities as [id, label] (id)}
							<button type="button" role="tab" aria-selected={shown === id} onclick={() => (activity = id)}>{label}</button>
						{/each}
					</div>
				{/if}

				{#if shown === 'breathing'}
					<div class="breath-wrap">
						<div class="breath" class:still style:transform={still ? 'none' : `scale(${breath.step.scale})`} style:transition-duration="{breath.step.seconds}s">
							<span class="breath-core"></span>
						</div>
						<div class="breath-label" aria-live="polite">
							<strong>{breath.step.label}</strong>
							<span class="mono muted">{breath.left}</span>
						</div>
					</div>
					<div class="row-tight" style="justify-content: center">
						{#each BREATH_PATTERNS as p (p.id)}
							<button type="button" class="btn btn-sm" class:btn-ghost={pattern.id !== p.id} aria-pressed={pattern.id === p.id} onclick={() => ((patternId = p.id), (stepStart = Date.now()))}>{p.name}</button>
						{/each}
					</div>
					<p class="small muted" style="text-align: center">{pattern.detail}</p>
				{:else if shown === 'prompts'}
					<div class="prompt-card" aria-live="polite">
						<Icon name="sparkle" size={22} />
						<p class="prompt">{prompt || 'Rest for a moment.'}</p>
					</div>
					{#if long}<p class="small muted" style="text-align: center">Long break: a short walk, a snack or some fresh air helps the next rounds most.</p>{/if}
				{:else if shown === 'meditation'}
					<div class="med">
						<div class="tiny muted strong">{med.name} · {medStep + 1} of {med.steps.length}</div>
						<p class="med-text" aria-live="polite">{med.steps[medStep]}</p>
						<div class="bar" style="max-width: 18rem; width: 100%"><span style="width: {Math.round(((medStep + 1) / med.steps.length) * 100)}%"></span></div>
						<div class="row-tight" style="justify-content: center">
							<button type="button" class="btn btn-sm btn-ghost" disabled={medStep === 0} onclick={() => ((medStep = Math.max(0, medStep - 1)), (medStart = Date.now()))}>Back</button>
							<button type="button" class="btn btn-sm" disabled={medStep >= med.steps.length - 1} onclick={() => ((medStep = medStep + 1), (medStart = Date.now()))}>Next</button>
						</div>
						<div class="row-tight" style="justify-content: center">
							{#each MEDITATIONS as m (m.id)}
								<button type="button" class="btn btn-sm" class:btn-ghost={med.id !== m.id} aria-pressed={med.id === m.id} onclick={() => ((medId = m.id), (medStep = 0), (medStart = Date.now()))}>{m.name}</button>
							{/each}
						</div>
					</div>
				{:else}
					<p class="prompt" style="text-align: center">Look away from the screen and rest for a moment.</p>
				{/if}

				<div class="row" style="justify-content: center; margin-top: auto">
					<button type="button" class="btn" onclick={() => timer('extend', 1)}>+1 minute</button>
					<button type="button" class="btn" onclick={() => (t.pausedAt ? timer('resume') : timer('pause'))}>
						<Icon name={t.pausedAt ? 'play' : 'pause'} size={16} />{t.pausedAt ? 'Resume' : 'Pause'}
					</button>
					<button type="button" class="btn btn-primary" onclick={() => (unlockAudio(), timer('skip'))}>I’m ready, end the break</button>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.break-screen {
		position: fixed;
		inset: 0;
		z-index: 900;
		background: color-mix(in srgb, var(--bg) 94%, var(--accent));
		display: flex;
		align-items: stretch;
		justify-content: center;
		overflow-y: auto;
	}
	.break-inner {
		width: min(40rem, 100%);
		padding: 1.25rem 1.25rem 2rem;
		display: flex;
		flex-direction: column;
		gap: 1.5rem;
		min-height: 100%;
	}
	.break-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.center {
		text-align: center;
		align-items: center;
		margin-top: 4vh;
	}
	.big-icon {
		width: 64px;
		height: 64px;
		border-radius: 999px;
		background: var(--accent-soft);
		color: var(--accent-text);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		align-self: center;
	}
	.break-time {
		font-size: clamp(3rem, 10vw, 4.5rem);
		font-weight: 600;
		letter-spacing: -0.02em;
		margin-top: 0.25rem;
	}
	.breath-wrap {
		position: relative;
		height: 15rem;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.breath {
		width: 13rem;
		height: 13rem;
		border-radius: 999px;
		background: radial-gradient(circle at 50% 45%, var(--accent-soft), color-mix(in srgb, var(--accent) 35%, var(--accent-soft)));
		border: 2px solid var(--accent-border);
		transition-property: transform;
		transition-timing-function: ease-in-out;
		display: flex;
		align-items: center;
		justify-content: center;
	}
	.breath.still {
		transition: none;
	}
	.breath-core {
		width: 22%;
		height: 22%;
		border-radius: 999px;
		background: var(--accent);
		opacity: 0.35;
	}
	.breath-label {
		position: absolute;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.125rem;
		font-size: 1.125rem;
		color: var(--text);
	}
	.prompt-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.875rem;
		color: var(--accent-text);
		padding: 2.5rem 1rem;
	}
	.prompt {
		font-family: var(--font-reading);
		font-size: 1.5rem;
		line-height: 1.4;
		color: var(--text);
		text-align: center;
		max-width: 28rem;
	}
	.med {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		text-align: center;
	}
	.med-text {
		font-family: var(--font-reading);
		font-size: 1.375rem;
		line-height: 1.45;
		max-width: 30rem;
		min-height: 6rem;
		display: flex;
		align-items: center;
	}
</style>
