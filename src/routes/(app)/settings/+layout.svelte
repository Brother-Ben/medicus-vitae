<script lang="ts">
	import { page } from '$app/state';
	import Icon from '#lib/components/Icon.svelte';
	import { guide, startGuide } from '#lib/client/guide.svelte.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	const tabs = [
		{ href: '/settings', label: 'Study & goals' },
		{ href: '/settings/layout', label: 'Menu & Today' },
		{ href: '/settings/appearance', label: 'Appearance' },
		{ href: '/settings/focus', label: 'Focus & breaks' },
		{ href: '/settings/anki', label: 'Anki sync' },
		{ href: '/settings/ai', label: 'AI' },
		{ href: '/settings/security', label: 'Security' },
		{ href: '/settings/sync', label: 'Backups & sync' },
		{ href: '/settings/data', label: 'Data' }
	];

	let nav = $state<HTMLElement | null>(null);
	// On a phone the sections are a row you swipe: keep the open one in view.
	$effect(() => {
		void page.url.pathname;
		nav?.querySelector('[aria-current="page"]')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
	});
</script>

<div class="page settings" style="max-width: 68rem">
	<div class="page-header">
		<h1>Settings</h1>
		<button type="button" class="btn btn-sm" disabled={guide.open} onclick={() => startGuide({ welcome: false })} title="A short walk through every tab and what you can do there">
			<Icon name="flag" size={15} />Take the tour
		</button>
	</div>
	<div class="settings-layout">
		<nav class="settings-nav" aria-label="Settings sections" bind:this={nav}>
			{#each tabs as t (t.href)}
				<a href={t.href} aria-current={page.url.pathname === t.href ? 'page' : undefined}>{t.label}</a>
			{/each}
		</nav>
		<div class="settings-body">
			{@render children()}
		</div>
	</div>
</div>

<style>
	.settings-layout {
		display: grid;
		grid-template-columns: 11.5rem minmax(0, 1fr);
		gap: 2rem;
		align-items: start;
	}
	.settings-nav {
		position: sticky;
		top: 1rem;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.settings-nav a {
		display: block;
		padding: 0.375rem 0.625rem;
		border-radius: var(--radius-sm);
		color: var(--text-2);
		font-size: 0.8125rem;
		font-weight: 550;
		text-decoration: none;
		white-space: nowrap;
	}
	.settings-nav a:hover {
		background: var(--hover);
		color: var(--text);
	}
	.settings-nav a[aria-current='page'] {
		background: var(--surface-2);
		color: var(--text);
		font-weight: 650;
	}
	.settings-body {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 1.25rem;
	}
	@media (max-width: 760px) {
		.settings-layout {
			grid-template-columns: minmax(0, 1fr);
			gap: 1rem;
		}
		.settings-nav {
			position: static;
			flex-direction: row;
			gap: 0.25rem;
			overflow-x: auto;
			padding-bottom: 0.375rem;
			border-bottom: 1px solid var(--border);
			scrollbar-width: thin;
			scroll-snap-type: x proximity;
		}
		.settings-nav a {
			flex: none;
			scroll-snap-align: start;
		}
	}
</style>
