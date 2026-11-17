<script lang="ts">
	import { goto, invalidate, invalidateAll } from '$app/navigation';
	import Icon from '#lib/components/Icon.svelte';
	import { unlockAudio } from '#lib/client/chime.js';
	import { editLive, endLive, live, liveTimeLeft, markItem, timer, wallClock } from '#lib/client/session.svelte.js';
	import { api } from '#lib/client/api.js';
	import { toastError } from '#lib/client/toast.svelte.js';
	import { durationLabel } from '#lib/dates.js';
	import { clockLabel } from '#lib/focus.js';
	import { ITEM_ICON, itemHref, type PlanItem } from '#lib/session.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// Live view when this is today's running session (the session bar's store), else what was loaded.
	const plan = $derived(live.plan && live.plan.id === data.plan.id ? live.plan : data.plan);
	const t = $derived(plan.timer);
	const finished = $derived(plan.status === 'done' || plan.status === 'abandoned');
	const doneCount = $derived(plan.items.filter((i) => i.done).length);
	const current = $derived(plan.items.find((i) => i.id === plan.currentItemId) ?? null);
	const now = $derived(live.now);
	const elapsed = $derived(Math.max(0, Math.round(((plan.completedAt ?? now) - (plan.startedAt ?? plan.createdAt)) / 1000)));
	const left = $derived(live.plan?.id === plan.id ? liveTimeLeft() : 0);
	const running = $derived(!!t && (t.phase === 'focus' || t.phase === 'break'));

	async function refresh() {
		await invalidate('app:session');
		await invalidate('app:shell');
	}

	async function toggle(item: PlanItem) {
		if (live.plan?.id === plan.id) await markItem(item.id, !item.done);
		else {
			try {
				await api(`/api/session/${plan.id}`, { body: { itemId: item.id, done: !item.done } });
			} catch (err) {
				toastError(err);
			}
		}
		await refresh();
	}

	async function edit(body: Record<string, unknown>) {
		await editLive(body);
		await refresh();
	}

	async function end() {
		await endLive();
		await invalidateAll();
	}

	function startItem(item: PlanItem) {
		unlockAudio();
		const href = itemHref(plan.id, item);
		void api(`/api/session/${plan.id}`, { body: { current: item.id } }).then(() => (href ? goto(href) : refresh()));
	}

	// Add your own task, or more time.
	let taskTitle = $state('');
	let taskMinutes = $state(15);
	async function addTask() {
		if (!taskTitle.trim()) return;
		await edit({ add: [{ id: crypto.randomUUID?.() ?? String(Math.random()).slice(2), type: 'custom', title: taskTitle.trim(), detail: `Your own task · about ${taskMinutes} min`, why: 'Added during the session.', minutes: taskMinutes }] });
		taskTitle = '';
	}
	let editingLength = $state(false);
	let lengthInput = $state(0);
</script>

<svelte:head><title>{plan.title || 'Session'} · Medicus Vitae</title></svelte:head>

<div class="page page-narrow" style="max-width: 50rem">
	<header class="page-header">
		<div>
			<div class="eyebrow">
				{plan.title ? `${plan.title} · ` : ''}{plan.budgetMinutes}-minute session
				{#if !finished}
					· <button type="button" class="link-btn" onclick={() => ((editingLength = !editingLength), (lengthInput = plan.budgetMinutes))}>change length</button>
				{/if}
			</div>
			<h1>{finished ? 'Session finished' : current ? current.title : 'All done'}</h1>
		</div>
		<div class="clock-col">
			<span class="tiny muted">{wallClock(now, live.prefs.clock)}</span>
			<span class="timer mono" aria-label="Time in session">{durationLabel(elapsed)} <span class="muted">/ {plan.budgetMinutes}m</span></span>
		</div>
	</header>

	{#if editingLength}
		<form
			class="row-tight"
			onsubmit={(e) => {
				e.preventDefault();
				void edit({ budgetMinutes: Number(lengthInput) }).then(() => (editingLength = false));
			}}
		>
			<label for="len" class="small">Session length</label>
			<input id="len" class="input mono" style="width: 6rem; min-height: 36px" type="number" min="5" max="600" bind:value={lengthInput} />
			<span class="small muted">minutes</span>
			<button class="btn btn-sm btn-primary">Save</button>
			<button type="button" class="btn btn-sm btn-ghost" onclick={() => (editingLength = false)}>Cancel</button>
		</form>
	{/if}

	<div class="bar"><span style="width: {Math.min(100, (elapsed / (plan.budgetMinutes * 60)) * 100)}%"></span></div>

	{#if !finished && plan.focus && t}
		<section class="card timer-card" class:on-break={t.phase === 'break'}>
			<div>
				<div class="phase">
					{t.pausedAt ? 'Paused' : t.phase === 'focus' ? `Focus · round ${t.rounds + 1}` : t.phase === 'break' ? (t.breakKind === 'long' ? 'Long break' : 'Break') : t.phase === 'ready-break' ? 'Break time' : 'Ready to focus'}
				</div>
				<div class="big mono">{running ? clockLabel(left) : '—'}</div>
				<div class="small muted">
					{t.rounds} round{t.rounds === 1 ? '' : 's'} done · {durationLabel(t.focusedSeconds + (t.phase === 'focus' ? Math.max(0, t.phaseSeconds - left) : 0))} focused ·
					{plan.focus.focusMinutes}/{plan.focus.shortBreakMinutes} min, long break {plan.focus.longBreakMinutes} min every {plan.focus.roundsBeforeLong}
				</div>
			</div>
			<div class="row-tight">
				{#if running}
					<button type="button" class="btn" onclick={() => (unlockAudio(), timer(t.pausedAt ? 'resume' : 'pause'))}><Icon name={t.pausedAt ? 'play' : 'pause'} size={16} />{t.pausedAt ? 'Resume' : 'Pause'}</button>
					<button type="button" class="btn" onclick={() => timer('extend', 5)}>+5 min</button>
					<button type="button" class="btn" onclick={() => timer('skip')}>{t.phase === 'focus' ? 'Take the break now' : 'End the break'}</button>
				{:else}
					<button type="button" class="btn btn-primary" onclick={() => (unlockAudio(), timer('start'))}>{t.phase === 'ready-break' ? 'Start break' : 'Start focusing'}</button>
				{/if}
				{#if t.phase === 'break'}<button type="button" class="btn btn-ghost" onclick={() => (live.breakHidden = false)}>Open break screen</button>{/if}
			</div>
		</section>
	{:else if !finished && !plan.focus}
		<div class="row-tight small muted">
			No focus timer for this session.
			<button type="button" class="btn btn-sm" onclick={() => edit({ focus: {} })}><Icon name="clock" size={16} />Turn on the focus timer</button>
		</div>
	{/if}

	{#if finished}
		<section class="card summary">
			<Icon name="check" size={28} />
			<div>
				<h2>Nice work.</h2>
				<p class="small muted" style="margin-top: 0.25rem">
					{doneCount} of {plan.items.length} done in {durationLabel(elapsed, 'long')}{t ? ` · ${t.rounds} focus round${t.rounds === 1 ? '' : 's'} (${durationLabel(t.focusedSeconds, 'long')} focused)` : ''}.
				</p>
			</div>
		</section>
	{/if}

	<section class="card" style="padding: 0.5rem 1.25rem">
		<ul class="items">
			{#each plan.items as item, i (item.id)}
				<li class:done={item.done} class:current={!finished && item.id === current?.id}>
					<button type="button" class="check" aria-pressed={!!item.done} aria-label="{item.done ? 'Mark not done' : 'Mark done'}: {item.title}" onclick={() => toggle(item)}>
						{#if item.done}<Icon name="check" size={14} stroke={3} />{/if}
					</button>
					<span class="type-icon"><Icon name={ITEM_ICON[item.type]} size={18} /></span>
					<div style="flex: 1 1 auto; min-width: 0">
						<div class="list-title" class:struck={item.done}>{item.title}</div>
						<div class="list-sub">{item.detail}</div>
						{#if !item.done}<p class="why small">{item.why}</p>{/if}
					</div>
					{#if !finished}
						<div class="item-actions">
							{#if !item.done}
								{#if itemHref(plan.id, item)}
									<button type="button" class="btn btn-sm" class:btn-primary={item.id === current?.id} onclick={() => startItem(item)}>{item.id === current?.id ? 'Go' : 'Start'}</button>
								{:else}
									<button type="button" class="btn btn-sm" class:btn-primary={item.id === current?.id} onclick={() => toggle(item)}>Done</button>
								{/if}
							{/if}
							<div class="reorder">
								<button type="button" class="icon-btn plain" aria-label="Move up" disabled={i === 0} onclick={() => edit({ move: { itemId: item.id, by: -1 } })}><Icon name="chevron-up" size={16} /></button>
								<button type="button" class="icon-btn plain" aria-label="Move down" disabled={i === plan.items.length - 1} onclick={() => edit({ move: { itemId: item.id, by: 1 } })}><Icon name="chevron-down" size={16} /></button>
							</div>
							{#if plan.items.length > 1}
								<button type="button" class="icon-btn plain" aria-label="Remove {item.title}" onclick={() => edit({ remove: item.id })}><Icon name="x" size={16} /></button>
							{/if}
						</div>
					{/if}
				</li>
			{/each}
		</ul>
	</section>

	{#if !finished}
		<form
			class="row-tight"
			onsubmit={(e) => {
				e.preventDefault();
				void addTask();
			}}
		>
			<label for="task" class="sr-only">Add your own task</label>
			<input id="task" class="input" style="flex: 1 1 14rem" placeholder="Add a task, e.g. 10 UWorld questions" bind:value={taskTitle} />
			<label for="task-min" class="sr-only">Minutes</label>
			<input id="task-min" class="input mono" style="width: 5.5rem" type="number" min="1" max="600" bind:value={taskMinutes} />
			<button class="btn" disabled={!taskTitle.trim()}><Icon name="plus" size={16} />Add</button>
		</form>
	{/if}

	<div class="row" style="justify-content: space-between">
		<span class="small muted">{doneCount} of {plan.items.length} done</span>
		{#if !finished}
			<div class="row-tight">
				{#if current}<a class="btn btn-primary" href="/session/{plan.id}/next" onclick={() => unlockAudio()}><Icon name="play" size={16} />Continue</a>{/if}
				<button type="button" class="btn" onclick={end}>{doneCount === plan.items.length ? 'Finish' : 'End session'}</button>
			</div>
		{:else}
			<a class="btn btn-primary" href="/">Back to Today</a>
		{/if}
	</div>
</div>

<style>
	.clock-col {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
	}
	.timer {
		font-size: 1.5rem;
		font-weight: 600;
	}
	.timer-card {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		border-color: var(--accent-border);
	}
	.timer-card.on-break {
		border-color: var(--border-strong);
	}
	.phase {
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--accent-text);
	}
	.big {
		font-size: 2.5rem;
		font-weight: 600;
		line-height: 1.1;
	}
	.summary {
		display: flex;
		gap: 1rem;
		align-items: center;
		color: var(--accent-text);
	}
	.summary h2 {
		color: var(--text);
	}
	.items {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	.items li {
		display: flex;
		align-items: flex-start;
		gap: 0.875rem;
		padding: 1rem 0;
		border-bottom: 1px solid var(--border);
	}
	.items li:last-child {
		border-bottom: 0;
	}
	.items li.current {
		background: color-mix(in srgb, var(--accent-soft) 55%, transparent);
		box-shadow: inset 2px 0 0 var(--accent);
		margin: 0 -1.25rem;
		padding-left: 1.25rem;
		padding-right: 1.25rem;
	}
	.check {
		width: 26px;
		height: 26px;
		margin-top: 2px;
		border-radius: 999px;
		border: 2px solid var(--border-strong);
		background: var(--surface);
		color: var(--on-accent);
		display: flex;
		align-items: center;
		justify-content: center;
		cursor: pointer;
		flex: none;
	}
	.check[aria-pressed='true'] {
		background: var(--accent);
		border-color: var(--accent);
	}
	.type-icon {
		color: var(--accent-text);
		margin-top: 3px;
	}
	.struck {
		text-decoration: line-through;
		color: var(--text-3);
	}
	.why {
		margin-top: 0.375rem;
		color: var(--text-2);
	}
	.item-actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
	}
	.reorder {
		display: flex;
		flex-direction: column;
	}
	.reorder .icon-btn {
		width: 28px;
		height: 22px;
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
