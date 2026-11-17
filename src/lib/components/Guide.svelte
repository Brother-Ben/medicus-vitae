<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { closeGuide, guide, setGuideStep } from '#lib/client/guide.svelte.js';
	import { toast } from '#lib/client/toast.svelte.js';
	import type { GuideStep } from '#lib/guide.js';
	import Icon from './Icon.svelte';

	// The first-time guide's card: it opens each tab in turn (the real page shows
	// behind it) and says what can be done there. It doesn't block the page.

	let { steps, shown, tutorReady }: { steps: GuideStep[]; shown: string[]; tutorReady: boolean } = $props();

	const index = $derived(Math.min(guide.step, steps.length - 1));
	const step = $derived(steps[index]);
	const last = $derived(index === steps.length - 1);
	const tabs = $derived(steps.filter((s) => s.id !== 'welcome'));
	const number = $derived(tabs.indexOf(step) + 1);
	const canGoBack = $derived(index > 0 && steps[index - 1].id !== 'welcome');

	/** A tab that isn't in the menu right now still gets its step, with a word on where it went. */
	const note = $derived.by(() => {
		if (!step || step.id === 'welcome' || step.id === 'settings') return '';
		if (step.id === 'tutor' && !tutorReady) return 'This tab shows in your menu once the tutor is set up.';
		if (!shown.includes(step.id)) return 'This tab is hidden from your menu. You can turn it back on in Settings › Menu & Today.';
		return '';
	});

	let nextBtn: HTMLButtonElement | undefined = $state();
	let card: HTMLElement | undefined = $state();

	// Each step starts at the top of the card (it scrolls on small screens).
	$effect(() => {
		guide.current = guide.open ? (step?.id ?? null) : null;
		if (card) card.scrollTop = 0;
	});

	// Next, Back and starting the tour open the step's page. Looking around on your
	// own, or reloading, leaves you where you are.
	$effect(() => {
		if (!guide.open || !guide.move || !step) return;
		guide.move = false;
		const href = step.href;
		untrack(() => {
			const focus = () => tick().then(() => nextBtn?.focus({ preventScroll: true }));
			if (href && page.url.pathname !== href) void goto(href).then(focus);
			else void focus();
		});
	});

	function skip() {
		void closeGuide();
		toast('You can take the tour again any time from Settings.');
	}

	function next() {
		if (last) void closeGuide();
		else setGuideStep(index + 1);
	}

	function back() {
		if (canGoBack) setGuideStep(index - 1);
	}

	function onWindowKey(e: KeyboardEvent) {
		if (!guide.open || e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
		const t = e.target as HTMLElement | null;
		if (t && !t.closest('.guide') && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
		skip();
	}

	function onCardKey(e: KeyboardEvent) {
		if (e.key === 'ArrowRight') {
			e.preventDefault();
			next();
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault();
			back();
		}
	}
</script>

<svelte:window onkeydown={onWindowKey} />

{#if guide.open && step}
	<div class="guide" bind:this={card} role="dialog" aria-modal="false" aria-labelledby="guide-title" aria-describedby="guide-intro" tabindex="-1" onkeydown={onCardKey}>
		<div class="g-top">
			<span class="g-count">{step.id === 'welcome' ? 'Quick tour' : `${number} of ${tabs.length}`}</span>
			<button type="button" class="icon-btn plain sm" aria-label="Close the tour" title="Close the tour (Esc)" onclick={skip}><Icon name="x" size={16} /></button>
		</div>
		{#if step.id !== 'welcome'}<div class="g-bar" aria-hidden="true"><span style="width: {(number / tabs.length) * 100}%"></span></div>{/if}
		<h2 id="guide-title">{step.title}</h2>
		<p id="guide-intro" class="g-intro">{step.intro}</p>
		{#if step.points.length}
			<ul class="g-points">
				{#each step.points as [name, text] (name)}
					<li><span class="g-name">{name}</span><span class="g-text">{text}</span></li>
				{/each}
			</ul>
		{/if}
		{#if note}<p class="g-note"><Icon name="info" size={14} />{note}</p>{/if}
		<div class="g-actions">
			{#if step.id === 'welcome'}
				<button type="button" class="btn btn-sm btn-ghost" onclick={skip}>Not now</button>
				<button type="button" class="btn btn-sm btn-primary" bind:this={nextBtn} onclick={next}>Start the tour<Icon name="arrow-right" size={14} /></button>
			{:else}
				{#if canGoBack}<button type="button" class="btn btn-sm btn-ghost" onclick={back}><Icon name="arrow-left" size={14} />Back</button>{/if}
				<button type="button" class="btn btn-sm btn-primary" bind:this={nextBtn} onclick={next}>
					{#if last}Finish{:else}Next: {steps[index + 1].title}<Icon name="arrow-right" size={14} />{/if}
				</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.guide {
		position: fixed;
		right: 1.25rem;
		bottom: 1.25rem;
		z-index: 45;
		width: min(23.5rem, calc(100vw - 2rem));
		max-height: calc(100vh - 2.5rem);
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		padding: 0.75rem 1rem 1rem;
		background: var(--surface);
		color: var(--text);
		border: 1px solid var(--border-strong);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		animation: guide-in 0.18s ease-out;
	}
	@keyframes guide-in {
		from {
			opacity: 0;
			transform: translateY(6px);
		}
	}
	.g-top {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-right: -0.375rem;
	}
	.g-count {
		font-size: 0.75rem;
		font-weight: 600;
		color: var(--text-3);
	}
	.g-bar {
		height: 3px;
		border-radius: 2px;
		background: var(--surface-2);
		overflow: hidden;
	}
	.g-bar span {
		display: block;
		height: 100%;
		background: var(--accent);
		transition: width 0.2s ease;
	}
	h2 {
		font-size: 1.0625rem;
		margin: 0.25rem 0 0;
	}
	.g-intro {
		margin: 0;
		font-size: 0.875rem;
		line-height: 1.5;
		color: var(--text-2);
	}
	.g-points {
		list-style: none;
		margin: 0.25rem 0 0;
		padding: 0.625rem 0 0;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.g-points li {
		display: flex;
		flex-direction: column;
		gap: 1px;
		font-size: 0.8125rem;
		line-height: 1.45;
	}
	.g-name {
		font-weight: 650;
	}
	.g-text {
		color: var(--text-2);
	}
	.g-note {
		display: flex;
		align-items: flex-start;
		gap: 0.375rem;
		margin: 0;
		padding: 0.5rem 0.625rem;
		border-radius: var(--radius-sm);
		background: var(--surface-2);
		font-size: 0.8125rem;
		color: var(--text-2);
	}
	.g-note :global(svg) {
		flex: none;
		margin-top: 2px;
	}
	.g-actions {
		display: flex;
		justify-content: flex-end;
		gap: 0.5rem;
		margin-top: 0.25rem;
	}
	/* Phones: above the tab bar, full width. */
	@media (max-width: 900px) {
		.guide {
			left: 0.75rem;
			right: 0.75rem;
			width: auto;
			bottom: calc(66px + env(safe-area-inset-bottom));
			max-height: 58vh;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.guide {
			animation: none;
		}
	}
	:global(:root[data-reduce-motion]) .guide {
		animation: none;
	}
</style>
