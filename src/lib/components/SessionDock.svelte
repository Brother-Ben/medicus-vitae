<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { unlockAudio } from '#lib/client/chime.js';
	import { currentItem, live, liveTimeLeft, markItem, timer, wallClock } from '#lib/client/session.svelte.js';
	import { clockLabel } from '#lib/focus.js';
	import { ITEM_ICON, itemHref } from '#lib/session.js';
	import Icon from './Icon.svelte';

	// The session bar: on every page while a session runs. The live clock, the
	// focus timer (or time so far), what you're working on, and one tap to finish
	// it and go to the next thing.

	let collapsed = $state(false);
	const plan = $derived(live.plan);
	const t = $derived(plan?.timer ?? null);
	const item = $derived(currentItem());
	const left = $derived(liveTimeLeft());
	const elapsed = $derived(plan ? Math.max(0, Math.round((live.now - (plan.startedAt ?? plan.createdAt)) / 1000)) : 0);
	const done = $derived(plan ? plan.items.filter((i) => i.done).length : 0);
	const onSessionPage = $derived(!!plan && page.url.pathname === `/session/${plan.id}`);
	const href = $derived(plan && item ? itemHref(plan.id, item) : null);
	const here = $derived(!!href && page.url.pathname === href.split('?')[0] && page.url.searchParams.get('item') === item?.id);

	const phaseLabel = $derived.by(() => {
		if (!t) return 'Session';
		if (t.pausedAt) return 'Paused';
		if (t.phase === 'focus') return `Focus · round ${t.rounds + 1}`;
		if (t.phase === 'break') return t.breakKind === 'long' ? 'Long break' : 'Break';
		if (t.phase === 'ready-break') return 'Break time';
		if (t.phase === 'ready-focus') return 'Ready to focus';
		return 'Session';
	});

	async function doneAndNext() {
		if (!plan || !item) return;
		unlockAudio();
		const id = plan.id;
		const after = item.id;
		await markItem(item.id, true);
		await goto(`/session/${id}/next?after=${after}`);
	}
</script>

{#if plan && !onSessionPage}
	<aside class="dock" class:collapsed class:on-break={t?.phase === 'break'} aria-label="Study session">
		{#if collapsed}
			<button type="button" class="dock-pill" onclick={() => (collapsed = false)} aria-label="Show the session bar">
				<span class="dot" class:paused={!!t?.pausedAt} class:brk={t?.phase === 'break'}></span>
				<span class="mono strong">{t && (t.phase === 'focus' || t.phase === 'break') ? clockLabel(left) : clockLabel(elapsed)}</span>
				<Icon name="chevron-up" size={16} />
			</button>
		{:else}
			<div class="dock-head">
				<span class="phase" class:brk={t?.phase === 'break'} class:paused={!!t?.pausedAt}>{phaseLabel}</span>
				<span class="tiny muted">{wallClock(live.now, live.prefs.clock)}</span>
				<button type="button" class="icon-btn plain small-btn" aria-label="Make the session bar small" onclick={() => (collapsed = true)}><Icon name="chevron-down" size={16} /></button>
			</div>
			<div class="dock-time">
				<span class="mono big">{t && (t.phase === 'focus' || t.phase === 'break') ? clockLabel(left) : clockLabel(elapsed)}</span>
				<span class="tiny muted">{t && (t.phase === 'focus' || t.phase === 'break') ? 'left' : `of ${plan.budgetMinutes} min`} · {done}/{plan.items.length} done</span>
			</div>
			{#if t && (t.phase === 'focus' || t.phase === 'break')}
				<div class="bar" style="height: 4px">
					<span style="width: {Math.min(100, Math.round(((t.phaseSeconds - left) / Math.max(1, t.phaseSeconds)) * 100))}%" class:brk={t.phase === 'break'}></span>
				</div>
			{/if}
			{#if item}
				<div class="dock-item">
					<span class="item-icon"><Icon name={ITEM_ICON[item.type]} size={16} /></span>
					<span class="truncate strong small" style="flex: 1 1 auto" title={item.title}>{item.title}</span>
				</div>
			{:else}
				<div class="small muted">Everything in this session is done.</div>
			{/if}
			<div class="dock-actions">
				{#if t && (t.phase === 'focus' || t.phase === 'break')}
					<button type="button" class="icon-btn" aria-label={t.pausedAt ? 'Resume the timer' : 'Pause the timer'} title={t.pausedAt ? 'Resume' : 'Pause'} onclick={() => (unlockAudio(), timer(t.pausedAt ? 'resume' : 'pause'))}>
						<Icon name={t.pausedAt ? 'play' : 'pause'} size={18} />
					</button>
					<button type="button" class="icon-btn" aria-label="Add 5 minutes" title="+5 minutes" onclick={() => timer('extend', 5)}><span class="mono tiny strong">+5</span></button>
					<button type="button" class="icon-btn" aria-label={t.phase === 'focus' ? 'Start the break now' : 'End the break now'} title={t.phase === 'focus' ? 'Break now' : 'End break'} onclick={() => timer('skip')}>
						<Icon name="arrow-right" size={18} />
					</button>
				{:else if t && (t.phase === 'ready-break' || t.phase === 'ready-focus')}
					<button type="button" class="btn btn-sm btn-primary" onclick={() => (unlockAudio(), timer('start'))}>{t.phase === 'ready-break' ? 'Start break' : 'Start focusing'}</button>
				{/if}
				<span class="spacer"></span>
				<a class="icon-btn" href="/session/{plan.id}" aria-label="Open the session plan" title="Session plan"><Icon name="list" size={18} /></a>
				{#if item}
					{#if href && !here}
						<a class="btn btn-sm" href={href} onclick={() => unlockAudio()}>Go</a>
					{/if}
					<button type="button" class="btn btn-sm btn-primary" disabled={live.busy} onclick={doneAndNext} title="Mark this done and go to the next item">Done, next<Icon name="arrow-right" size={14} /></button>
				{/if}
			</div>
		{/if}
	</aside>
{/if}

<style>
	.dock {
		position: fixed;
		right: 1rem;
		bottom: 1rem;
		z-index: 40;
		width: min(21rem, calc(100vw - 2rem));
		background: var(--surface);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-lg);
		box-shadow: 0 10px 30px -12px color-mix(in srgb, var(--text) 40%, transparent);
		padding: 0.75rem 0.875rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.dock.collapsed {
		width: auto;
		padding: 0;
		border-radius: 999px;
	}
	.dock.on-break {
		border-color: var(--accent-border);
	}
	.dock-pill {
		display: inline-flex;
		align-items: center;
		gap: 0.5rem;
		min-height: 44px;
		padding: 0 0.875rem;
		border: 0;
		background: transparent;
		color: var(--text);
		cursor: pointer;
		border-radius: 999px;
	}
	.dot {
		width: 10px;
		height: 10px;
		border-radius: 999px;
		background: var(--accent);
	}
	.dot.brk {
		background: var(--decor-1, var(--weak));
	}
	.dot.paused {
		background: var(--text-3);
	}
	.dock-head {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.phase {
		font-size: 0.75rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--accent-text);
		flex: 1 1 auto;
	}
	.phase.brk {
		color: var(--text-2);
	}
	.phase.paused {
		color: var(--text-3);
	}
	.small-btn {
		width: 32px;
		height: 32px;
	}
	.dock-time {
		display: flex;
		align-items: baseline;
		gap: 0.5rem;
	}
	.big {
		font-size: 1.75rem;
		font-weight: 600;
		line-height: 1.1;
	}
	.bar .brk {
		background: var(--text-3);
	}
	.dock-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		min-width: 0;
	}
	.item-icon {
		color: var(--accent-text);
		display: inline-flex;
	}
	.dock-actions {
		display: flex;
		align-items: center;
		gap: 0.375rem;
	}
	.dock-actions .icon-btn {
		width: 38px;
		height: 38px;
	}
	@media (max-width: 900px) {
		.dock {
			right: 0.5rem;
			left: 0.5rem;
			width: auto;
			bottom: calc(72px + env(safe-area-inset-bottom));
		}
		.dock.collapsed {
			left: auto;
		}
	}
</style>
