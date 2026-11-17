<script lang="ts">
	import { invalidate } from '$app/navigation';
	import Icon from '#lib/components/Icon.svelte';
	import { api } from '#lib/client/api.js';
	import { chime, unlockAudio } from '#lib/client/chime.js';
	import { toastError } from '#lib/client/toast.svelte.js';
	import { BREATH_PATTERNS, MEDITATIONS, PROMPT_KINDS, type FocusPrefs, type PromptKind } from '#lib/focus.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// The page edits its own copy (saved as you go); the server's copy only seeds it.
	const initial = () => structuredClone(data.prefs);
	let p = $state<FocusPrefs>(initial());
	let saved = $state<'idle' | 'saving' | 'saved'>('idle');
	let timer: ReturnType<typeof setTimeout> | null = null;
	let pending: Partial<FocusPrefs> = {};

	/** Saves a moment after the last change. */
	function set(patch: Partial<FocusPrefs>) {
		p = { ...p, ...patch };
		pending = { ...pending, ...patch };
		saved = 'saving';
		if (timer) clearTimeout(timer);
		timer = setTimeout(async () => {
			const body = pending;
			pending = {};
			try {
				const r = await api<{ prefs: FocusPrefs }>('/api/focus', { body });
				p = { ...r.prefs, ...pending };
				saved = 'saved';
				void invalidate('app:shell');
			} catch (err) {
				toastError(err);
				saved = 'idle';
			}
		}, 400);
	}

	const num = (e: Event) => Number((e.currentTarget as HTMLInputElement).value);
	const checked = (e: Event) => (e.currentTarget as HTMLInputElement).checked;

	let presetText = $state(initial().presets.join(', '));
	function savePresets() {
		const list = presetText
			.split(/[,\s]+/)
			.map(Number)
			.filter((n) => Number.isFinite(n) && n >= 5 && n <= 600);
		if (list.length) set({ presets: list });
	}
</script>

<svelte:head><title>Focus & breaks · Settings · Medicus Vitae</title></svelte:head>

<div class="row small muted" style="justify-content: flex-end; margin-bottom: -0.5rem" aria-live="polite">
	{saved === 'saving' ? 'Saving…' : saved === 'saved' ? 'Saved' : 'Changes save by themselves'}
</div>

<section class="card stack" aria-labelledby="timer-h">
	<div>
		<h2 id="timer-h">Focus timer</h2>
		<p class="small muted" style="margin-top: 0.25rem">Work in focused rounds with short breaks in between (the Pomodoro method). You can change these for a single session when you plan it.</p>
	</div>
	<label class="checkbox"><input type="checkbox" checked={p.useTimer} onchange={(e) => set({ useTimer: checked(e) })} />Use the focus timer in new sessions</label>
	<div class="form-grid">
		<div class="field"><label for="f-focus">Focus round (minutes)</label><input id="f-focus" class="input mono" type="number" min="5" max="180" value={p.focusMinutes} onchange={(e) => set({ focusMinutes: num(e) })} /></div>
		<div class="field"><label for="f-short">Short break (minutes)</label><input id="f-short" class="input mono" type="number" min="1" max="60" value={p.shortBreakMinutes} onchange={(e) => set({ shortBreakMinutes: num(e) })} /></div>
		<div class="field"><label for="f-long">Long break (minutes)</label><input id="f-long" class="input mono" type="number" min="1" max="90" value={p.longBreakMinutes} onchange={(e) => set({ longBreakMinutes: num(e) })} /></div>
		<div class="field"><label for="f-rounds">Long break after every</label><div class="row-tight"><input id="f-rounds" class="input mono" style="width: 6rem" type="number" min="1" max="12" value={p.roundsBeforeLong} onchange={(e) => set({ roundsBeforeLong: num(e) })} /><span class="small muted">rounds</span></div></div>
	</div>
	<div class="row-tight">
		{#each [[25, 5, 15, 4, 'Classic 25/5'], [50, 10, 20, 3, 'Long 50/10'], [45, 15, 30, 2, 'Deep 45/15'], [15, 3, 10, 4, 'Short 15/3']] as [f, s, l, r, name] (name)}
			<button type="button" class="btn btn-sm" onclick={() => set({ focusMinutes: Number(f), shortBreakMinutes: Number(s), longBreakMinutes: Number(l), roundsBeforeLong: Number(r) })}>{name}</button>
		{/each}
	</div>
	<label class="checkbox"><input type="checkbox" checked={p.autoStartBreaks} onchange={(e) => set({ autoStartBreaks: checked(e) })} />Start breaks by themselves when a round ends</label>
	<label class="checkbox"><input type="checkbox" checked={p.autoStartFocus} onchange={(e) => set({ autoStartFocus: checked(e) })} />Start the next round by itself when a break ends</label>
	<p class="hint" style="margin-top: -0.75rem">When it’s off, you’ll see “Ready for the next round?” and choose when to start.</p>
	<div class="field">
		<label for="f-presets">Session lengths to choose from (minutes)</label>
		<div class="row-tight">
			<input id="f-presets" class="input mono" style="max-width: 20rem" bind:value={presetText} onchange={savePresets} />
			<span class="small muted">e.g. 15, 25, 45, 60, 90</span>
		</div>
		<span class="hint">The buttons under “Plan a session” on Today.</span>
	</div>
	<div class="field">
		<span class="label" id="clock-l">Clock in the session bar</span>
		<div class="segmented" role="radiogroup" aria-labelledby="clock-l">
			<button type="button" role="radio" aria-checked={p.clock === '12h'} onclick={() => set({ clock: '12h' })}>3:45 PM</button>
			<button type="button" role="radio" aria-checked={p.clock === '24h'} onclick={() => set({ clock: '24h' })}>15:45</button>
		</div>
	</div>
</section>

<section class="card stack" aria-labelledby="breaks-h">
	<div>
		<h2 id="breaks-h">Breaks</h2>
		<p class="small muted" style="margin-top: 0.25rem">What the break screen offers. Turn on what helps you; you can switch between them during a break.</p>
	</div>
	<div class="field">
		<span class="label" id="act-l">Breaks start with</span>
		<div class="segmented" role="radiogroup" aria-labelledby="act-l">
			{#each [['breathing', 'Breathing'], ['prompts', 'Relax reminders'], ['meditation', 'Meditation'], ['mix', 'Whatever’s first']] as [v, l] (v)}
				<button type="button" role="radio" aria-checked={p.breakActivity === v} onclick={() => set({ breakActivity: v as FocusPrefs['breakActivity'] })}>{l}</button>
			{/each}
		</div>
	</div>

	<div class="sub">
		<label class="checkbox"><input type="checkbox" checked={p.breathing} onchange={(e) => set({ breathing: checked(e) })} /><strong>Breathing guide</strong></label>
		{#if p.breathing}
			<div class="choices" role="radiogroup" aria-label="Breathing pattern">
				{#each BREATH_PATTERNS as b (b.id)}
					<button type="button" role="radio" class="choice" aria-checked={p.breathPattern === b.id} onclick={() => set({ breathPattern: b.id })}>
						<span class="strong">{b.name}</span><span class="tiny muted">{b.detail}</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>

	<div class="sub">
		<label class="checkbox"><input type="checkbox" checked={p.prompts} onchange={(e) => set({ prompts: checked(e) })} /><strong>Gentle reminders</strong></label>
		{#if p.prompts}
			<div class="row-tight" style="padding-left: 1.875rem">
				{#each PROMPT_KINDS as k (k.id)}
					<label class="checkbox" style="min-height: 36px; margin-right: 0.75rem">
						<input type="checkbox" checked={p.promptKinds[k.id]} onchange={(e) => set({ promptKinds: { ...p.promptKinds, [k.id]: checked(e) } as Record<PromptKind, boolean> })} />{k.name}
					</label>
				{/each}
			</div>
		{/if}
	</div>

	<div class="sub">
		<label class="checkbox"><input type="checkbox" checked={p.meditation} onchange={(e) => set({ meditation: checked(e) })} /><strong>Short guided meditation</strong></label>
		{#if p.meditation}
			<div class="choices" role="radiogroup" aria-label="Meditation">
				{#each MEDITATIONS as m (m.id)}
					<button type="button" role="radio" class="choice" aria-checked={p.meditationScript === m.id} onclick={() => set({ meditationScript: m.id })}>
						<span class="strong">{m.name}</span><span class="tiny muted">{m.steps[1]}</span>
					</button>
				{/each}
			</div>
		{/if}
	</div>
</section>

<section class="card stack" aria-labelledby="sound-h">
	<h2 id="sound-h">Sound</h2>
	<label class="checkbox"><input type="checkbox" checked={p.chime} onchange={(e) => set({ chime: checked(e) })} />Play a soft chime when a round or break ends</label>
	{#if p.chime}
		<div class="form-grid">
			<div class="field">
				<span class="label" id="snd-l">Chime</span>
				<div class="segmented" role="radiogroup" aria-labelledby="snd-l">
					{#each [['bell', 'Bell'], ['soft', 'Soft tones'], ['wood', 'Wood knock']] as [v, l] (v)}
						<button type="button" role="radio" aria-checked={p.chimeSound === v} onclick={() => (unlockAudio(), set({ chimeSound: v as FocusPrefs['chimeSound'] }), chime(v as FocusPrefs['chimeSound'], p.chimeVolume))}>{l}</button>
					{/each}
				</div>
			</div>
			<div class="field">
				<label for="vol">Volume</label>
				<input id="vol" type="range" min="0" max="1" step="0.05" value={p.chimeVolume} onchange={(e) => set({ chimeVolume: num(e) })} style="accent-color: var(--accent)" />
			</div>
		</div>
		<div><button type="button" class="btn btn-sm" onclick={() => (unlockAudio(), chime(p.chimeSound, p.chimeVolume))}><Icon name="play" size={16} />Play it</button></div>
	{/if}
</section>

<style>
	.sub {
		border-top: 1px solid var(--border);
		padding-top: 0.5rem;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.choices {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(13rem, 1fr));
		gap: 0.5rem;
		padding-left: 1.875rem;
	}
	.choice {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 0.125rem;
		text-align: left;
		padding: 0.625rem 0.75rem;
		border: 1px solid var(--border-strong);
		border-radius: var(--radius);
		background: var(--surface);
		color: var(--text);
		cursor: pointer;
	}
	.choice[aria-checked='true'] {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
</style>
