<script lang="ts" module>
	import type { HomeSectionId, LayoutItem, NavId } from '#lib/appearance.js';

	export interface ShellData {
		displayName: string;
		initial: string;
		dueCount: number;
		openMistakes: number;
		testDate: string | null;
		daysToTest: number | null;
		role: 'primary' | 'standby' | 'handing_off';
		allowQuit: boolean;
		version: string;
		hostName: string;
		standby: { heldAt: number | null; source: string | null } | null;
		conflict: boolean;
		/** Show the Tutor area: an AI service is connected, or there are approved questions or items to review. */
		tutor: boolean;
		/** AI-made items waiting for approval. */
		pendingApprovals: number;
		/** Today's session in progress (the session bar). */
		session: import('#lib/server/planner.js').SessionView | null;
		focusPrefs: import('#lib/focus.js').FocusPrefs;
		/** The account's menu and Today layout, as saved (the browser takes over once its settings are read). */
		layout: { nav: LayoutItem<NavId>[]; home: LayoutItem<HomeSectionId>[] };
		/** The first-time guide was finished or skipped (otherwise it opens once by itself). */
		guideDone: boolean;
	}
</script>

<script lang="ts">
	import { untrack, type Snippet } from 'svelte';
	import { page } from '$app/state';
	import { NAV_ITEMS } from '#lib/appearance.js';
	import { appearance, setDeviceAppearance } from '#lib/client/appearance.svelte.js';
	import { relativeTime } from '#lib/dates.js';
	import { syncSession } from '#lib/client/session.svelte.js';
	import { guide, resumeGuide, shouldOfferGuide, startGuide } from '#lib/client/guide.svelte.js';
	import { guideSteps } from '#lib/guide.js';
	import BreakOverlay from './BreakOverlay.svelte';
	import Decorations from './Decorations.svelte';
	import Guide from './Guide.svelte';
	import Icon from './Icon.svelte';
	import Logo from './Logo.svelte';
	import Modal from './Modal.svelte';
	import SessionDock from './SessionDock.svelte';

	let { shell, children }: { shell: ShellData; children: Snippet } = $props();

	// The session bar and break screen follow the server's view of today's session
	// (only fresh page data re-runs this; the store's own changes don't).
	$effect(() => {
		const session = shell.session;
		const prefs = shell.focusPrefs;
		untrack(() => syncSession(session, prefs));
	});

	/** Pages where the owner studies: decorations hold still there (Settings › Appearance). */
	const studying = $derived(
		appearance.studying || /^\/(review|session|quiz)(\/|$)/.test(page.url.pathname) || /^\/library\/[^/]+\/read/.test(page.url.pathname) || /^\/cards\/cars\/[^/]+$/.test(page.url.pathname)
	);

	const MATCH: Record<NavId, (p: string) => boolean> = {
		today: (p) => p === '/' || p.startsWith('/session'),
		library: (p) => p.startsWith('/library'),
		cards: (p) => p.startsWith('/cards') || p.startsWith('/review'),
		mistakes: (p) => p.startsWith('/mistakes'),
		tutor: (p) => p.startsWith('/tutor') || p.startsWith('/quiz'),
		progress: (p) => p.startsWith('/progress'),
		notes: (p) => p.startsWith('/notes'),
		search: (p) => p.startsWith('/search')
	};

	const navPrefs = $derived(appearance.loaded ? appearance.account.nav : shell.layout.nav);
	const nav = $derived(
		navPrefs
			.filter((p) => p.visible && (p.id !== 'tutor' || shell.tutor))
			.map((p) => {
				const item = NAV_ITEMS.find((n) => n.id === p.id)!;
				return {
					id: p.id,
					href: item.href,
					label: item.label,
					short: 'short' in item ? item.short : item.label,
					icon: item.icon as string,
					match: MATCH[p.id],
					badge: p.id === 'cards' ? shell.dueCount : p.id === 'tutor' ? shell.pendingApprovals : 0
				};
			})
	);
	// The first-time guide: every tab in this menu's order. It opens by itself once
	// per account (not on a study page, a standby copy or in focus mode); a tour left
	// open before a reload carries on.
	const guideList = $derived(guideSteps(navPrefs.map((p) => p.id), { welcome: guide.welcome }));
	$effect(() => {
		const done = shell.guideDone;
		const busy = studying || appearance.focus || shell.role !== 'primary';
		untrack(() => {
			if (resumeGuide() || busy) return;
			if (shouldOfferGuide(done)) startGuide({ welcome: true });
		});
	});

	// Phones: the first four menu items as tabs, the rest under More.
	const tabs = $derived(nav.slice(0, 4));
	const moreItems = $derived(nav.slice(4));
	const path = $derived(page.url.pathname);
	const collapsed = $derived(appearance.device.sidebar === 'collapsed');

	function toggleSidebar() {
		setDeviceAppearance({ sidebar: collapsed ? 'expanded' : 'collapsed' });
	}

	function onKey(e: KeyboardEvent) {
		if (e.key !== '[' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
		const t = e.target as HTMLElement | null;
		if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
		if (document.querySelector('dialog[open]')) return;
		e.preventDefault();
		toggleSidebar();
	}

	let quitOpen = $state(false);
	let moreOpen = $state(false);
	let quitting = $state(false);
	let stopped = $state(false);
	let quitError = $state('');

	async function quit() {
		quitting = true;
		quitError = '';
		try {
			const res = await fetch('/api/system/quit', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
			if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? 'Could not quit.');
			quitOpen = false;
			stopped = true;
		} catch (err) {
			quitError = err instanceof Error ? err.message : String(err);
		} finally {
			quitting = false;
		}
	}

	const badgeText = (n: number) => (n > 999 ? '999+' : String(n));
	const testDayText = $derived(
		shell.daysToTest === null ? '' : shell.daysToTest > 0 ? `${shell.daysToTest} days` : shell.daysToTest === 0 ? 'Today' : 'Passed'
	);
</script>

<svelte:window onkeydown={onKey} />

{#if stopped}
	<main class="stopped">
		<div class="stopped-card">
			<Logo size={48} />
			<h1>Medicus Vitae has stopped</h1>
			<p class="muted">The server is shut down and the tray icon is gone. You can close this tab.</p>
			<p class="muted small">To start again, open <strong>Medicus Vitae</strong> from your desktop or Start menu.</p>
		</div>
	</main>
{:else}
	<div class="app" class:focus={appearance.focus}>
		<nav class="sidebar" aria-label="Main">
			<div class="sidebar-decor"><Decorations place="sidebar-top" /></div>
			<div class="brand-row">
				<a class="brand" href="/" title="Medicus Vitae">
					<Logo size={26} />
					<span class="brand-name"><strong>Medicus</strong> <span class="brand-second">Vitae</span></span>
				</a>
				<button
					type="button"
					class="icon-btn plain sm collapse-btn"
					onclick={toggleSidebar}
					aria-expanded={!collapsed}
					aria-label={collapsed ? 'Open the sidebar' : 'Fold the sidebar'}
					title="{collapsed ? 'Open' : 'Fold'} the sidebar ( [ )"
				>
					<Icon name="sidebar" size={17} />
				</button>
			</div>
			<div class="nav-list">
				{#each nav as item (item.id)}
					<a href={item.href} class="nav-item" class:guided={guide.open && guide.current === item.id} aria-current={item.match(path) ? 'page' : undefined} title={item.label}>
						<span class="nav-icon">
							<Icon name={item.icon} size={18} />
							{#if item.badge}<span class="nav-dot" aria-hidden="true"></span>{/if}
						</span>
						<span class="nav-label">{item.label}</span>
						{#if item.badge}
							<span class="nav-badge mono" aria-label="{item.badge} waiting">{badgeText(item.badge)}</span>
						{/if}
					</a>
				{/each}
			</div>
			<div class="sidebar-foot">
				<Decorations place="sidebar-foot" />
				{#if shell.testDate && appearance.account.showTestDay}
					<div class="test-day" title="Test day: {shell.testDate}">
						<Icon name="calendar" size={16} />
						<span class="nav-label"><span class="test-day-date">{shell.testDate}</span>{#if testDayText}<span class="muted"> · {testDayText}</span>{/if}</span>
					</div>
				{/if}
				<a href="/settings" class="nav-item" class:guided={guide.open && guide.current === 'settings'} aria-current={path.startsWith('/settings') ? 'page' : undefined} title="Settings">
					<span class="nav-icon"><Icon name="settings" size={18} /></span>
					<span class="nav-label">Settings</span>
				</a>
				<div class="foot-row">
					<span class="tiny muted version nav-label" title="Medicus Vitae v{shell.version} on {shell.hostName}">v{shell.version} · {shell.hostName}</span>
					{#if shell.allowQuit}
						<button type="button" class="icon-btn plain sm quit" onclick={() => (quitOpen = true)} aria-label="Quit Medicus" title="Quit Medicus">
							<Icon name="power" size={16} />
						</button>
					{/if}
				</div>
			</div>
		</nav>

		<div class="main-col">
			<header class="mobile-top">
				<div class="mobile-decor"><Decorations place="mobile-top" /></div>
				<a class="brand" href="/">
					<Logo size={24} />
					<span class="brand-name"><strong>Medicus</strong></span>
				</a>
				<div class="row-tight">
					<a href="/search" class="icon-btn plain" aria-label="Search"><Icon name="search" /></a>
					<a href="/settings" class="icon-btn plain" aria-label="Settings"><Icon name="settings" /></a>
				</div>
			</header>

			{#if shell.standby}
				<div class="banner banner-warn" role="status">
					<Icon name="database" size={16} />
					<span>
						{shell.role === 'handing_off' ? 'Handing over to the other device. ' : 'This device is a standby: a read-only copy'}
						{#if shell.role !== 'handing_off'}
							{shell.standby.source ? ` from ${shell.standby.source}` : ''}{shell.standby.heldAt
								? `, snapshot from ${relativeTime(shell.standby.heldAt)}`
								: ''}.
						{/if}
					</span>
					<a href="/settings/sync" class="btn btn-sm">Make this device primary</a>
				</div>
			{/if}
			{#if shell.conflict}
				<div class="banner banner-warn" role="alert">
					<Icon name="alert" size={16} />
					<span>Both devices took changes while switching. Both copies are kept; choose which one to keep.</span>
					<a href="/settings/sync" class="btn btn-sm">Review</a>
				</div>
			{/if}

			<main id="main" class="main">
				{@render children()}
			</main>
		</div>

		<nav class="tabbar" aria-label="Tabs">
			{#each tabs as item (item.id)}
				<a href={item.href} class:guided={guide.open && guide.current === item.id} aria-current={item.match(path) ? 'page' : undefined}>
					<span class="tab-icon">
						<Icon name={item.icon} size={22} />
						{#if item.badge}<span class="tab-badge mono">{item.badge > 99 ? '99+' : item.badge}</span>{/if}
					</span>
					{item.short}
				</a>
			{/each}
			<button type="button" onclick={() => (moreOpen = true)} aria-haspopup="dialog">
				<span class="tab-icon"><Icon name="menu" size={22} /></span>
				More
			</button>
		</nav>
	</div>
	<Decorations place="overlay" {studying} />
	<SessionDock />
	<Guide steps={guideList} shown={nav.map((n) => n.id)} tutorReady={shell.tutor} />
	<BreakOverlay />
{/if}

<Modal bind:open={moreOpen} title="More">
	<div class="stack-sm">
		{#each moreItems as item (item.id)}
			<a class="btn btn-block more-link" href={item.href} onclick={() => (moreOpen = false)}><Icon name={item.icon} size={18} />{item.label}</a>
		{/each}
		<a class="btn btn-block more-link" href="/settings" onclick={() => (moreOpen = false)}><Icon name="settings" size={18} />Settings</a>
		<a class="btn btn-block more-link" href="/settings/layout" onclick={() => (moreOpen = false)}><Icon name="list" size={18} />Edit the menu</a>
		{#if shell.allowQuit}
			<button type="button" class="btn btn-block btn-danger more-link" onclick={() => ((moreOpen = false), (quitOpen = true))}>
				<Icon name="power" size={18} />Quit Medicus
			</button>
		{/if}
	</div>
</Modal>

<Modal bind:open={quitOpen} title="Quit Medicus?">
	<p>This stops the Medicus Vitae server on <strong>{shell.hostName}</strong> and removes its tray icon. Everything is already saved.</p>
	<p class="muted small">Open Medicus Vitae again any time from the desktop or Start menu shortcut.</p>
	{#if quitError}<div class="error-box">{quitError}</div>{/if}
	{#snippet footer()}
		<button type="button" class="btn" onclick={() => (quitOpen = false)}>Cancel</button>
		<button type="button" class="btn btn-danger-solid" disabled={quitting} onclick={quit}>
			<Icon name="power" size={16} />{quitting ? 'Quitting…' : 'Quit'}
		</button>
	{/snippet}
</Modal>

<style>
	.app {
		display: flex;
		min-height: 100vh;
	}
	.sidebar {
		flex: 0 0 13.75rem;
		width: 13.75rem;
		background: var(--sidebar);
		border-right: 1px solid var(--border);
		padding: 0.75rem 0.625rem 0.625rem;
		display: flex;
		flex-direction: column;
		gap: 1rem;
		position: sticky;
		top: 0;
		height: 100vh;
		overflow-y: auto;
		overflow-x: hidden;
		transition:
			width 0.18s ease,
			flex-basis 0.18s ease;
	}
	/* Decorations along the sidebar's top edge take no room from it. */
	.sidebar-decor,
	.mobile-decor {
		position: absolute;
		top: 0;
		left: 0;
		right: 0;
		pointer-events: none;
		z-index: 1;
	}
	.mobile-decor {
		height: 0;
	}
	.brand-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.25rem;
		min-height: 2.25rem;
		padding-left: 0.375rem;
		position: relative;
		z-index: 2;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		text-decoration: none;
		color: var(--text);
		min-width: 0;
	}
	.brand:hover {
		color: var(--text);
		text-decoration: none;
	}
	.brand-name {
		font-size: 0.9375rem;
		letter-spacing: -0.01em;
		white-space: nowrap;
	}
	.brand-name strong {
		font-weight: 700;
	}
	.brand-second {
		font-weight: 400;
		color: var(--text-2);
	}
	.collapse-btn {
		color: var(--text-3);
	}
	/* Focus mode (reviews): only the card. */
	.app.focus .sidebar,
	.app.focus .mobile-top,
	.app.focus .tabbar,
	.app.focus .banner {
		display: none;
	}
	.nav-list {
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.nav-item {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		min-height: 2rem;
		padding: 0 0.5rem;
		border-radius: var(--radius-sm);
		text-decoration: none;
		font-size: 0.8125rem;
		font-weight: 500;
		color: var(--text-2);
		border: 0;
		background: transparent;
		width: 100%;
		text-align: left;
		cursor: pointer;
		white-space: nowrap;
	}
	@media (pointer: coarse) {
		.nav-item {
			min-height: 2.5rem;
		}
	}
	.nav-item:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.nav-item[aria-current='page'] {
		color: var(--accent-text);
		background: var(--accent-soft);
		font-weight: 600;
	}
	/* The tab the first-time guide is showing. */
	.nav-item.guided,
	.tabbar a.guided {
		box-shadow: inset 0 0 0 2px var(--accent);
	}
	.nav-icon {
		position: relative;
		display: inline-flex;
		flex: none;
	}
	.nav-dot {
		display: none;
		position: absolute;
		top: -2px;
		right: -3px;
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--accent);
		box-shadow: 0 0 0 2px var(--sidebar);
	}
	.nav-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.nav-badge {
		margin-left: auto;
		font-size: 0.6875rem;
		font-weight: 600;
		color: var(--text-2);
		background: var(--surface-2);
		border-radius: 4px;
		padding: 0 0.375rem;
		line-height: 1.25rem;
	}
	.nav-item[aria-current='page'] .nav-badge {
		background: var(--surface);
		color: var(--accent-text);
	}
	.sidebar-foot {
		margin-top: auto;
		display: flex;
		flex-direction: column;
		gap: 1px;
	}
	.test-day {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.375rem 0.5rem;
		margin-bottom: 0.25rem;
		font-size: 0.75rem;
		color: var(--text-2);
		white-space: nowrap;
	}
	.test-day-date {
		font-weight: 600;
		color: var(--text);
	}
	.foot-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.25rem;
		padding: 0.25rem 0 0 0.5rem;
		min-height: 2rem;
	}
	.version {
		white-space: nowrap;
	}
	.quit {
		color: var(--text-3);
	}
	.quit:hover {
		color: var(--weak-text);
		background: var(--weak-soft);
	}

	/* Folded: an icon rail. Applied from the device setting before the first paint (data-sidebar on <html>). */
	:global(:root[data-sidebar='collapsed']) .sidebar {
		flex-basis: 3.5rem;
		width: 3.5rem;
		padding-left: 0.5rem;
		padding-right: 0.5rem;
		align-items: stretch;
	}
	:global(:root[data-sidebar='collapsed']) .brand-row {
		flex-direction: column;
		padding-left: 0;
		gap: 0.5rem;
	}
	:global(:root[data-sidebar='collapsed']) .brand-name,
	:global(:root[data-sidebar='collapsed']) .nav-label,
	:global(:root[data-sidebar='collapsed']) .nav-badge {
		position: absolute;
		width: 1px;
		height: 1px;
		overflow: hidden;
		clip: rect(0, 0, 0, 0);
		white-space: nowrap;
	}
	:global(:root[data-sidebar='collapsed']) .nav-item {
		justify-content: center;
		padding: 0;
		min-height: 2.25rem;
	}
	:global(:root[data-sidebar='collapsed']) .nav-dot {
		display: block;
	}
	:global(:root[data-sidebar='collapsed']) .test-day {
		justify-content: center;
		padding: 0.375rem 0;
	}
	:global(:root[data-sidebar='collapsed']) .foot-row {
		justify-content: center;
		padding-left: 0;
	}

	.main-col {
		flex: 1 1 auto;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.main {
		flex: 1 1 auto;
		min-width: 0;
	}
	.banner {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.5rem;
		padding: 0.5rem 1.25rem;
		font-size: 0.8125rem;
		border-bottom: 1px solid var(--border);
	}
	.banner span {
		flex: 1 1 16rem;
	}
	.banner-warn {
		background: var(--weak-soft);
		color: var(--weak-text);
	}
	.mobile-top,
	.tabbar {
		display: none;
	}
	.more-link {
		justify-content: flex-start;
	}
	.stopped {
		min-height: 100vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
	}
	.stopped-card {
		max-width: 28rem;
		text-align: center;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 0.75rem;
	}
	@media (max-width: 900px) {
		.sidebar {
			display: none;
		}
		.mobile-top {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 0.375rem 0.5rem 0.375rem 0.875rem;
			background: var(--sidebar);
			border-bottom: 1px solid var(--border);
			position: sticky;
			top: 0;
			z-index: 20;
		}
		.tabbar {
			display: grid;
			grid-template-columns: repeat(5, minmax(0, 1fr));
			position: fixed;
			left: 0;
			right: 0;
			bottom: 0;
			background: var(--sidebar);
			border-top: 1px solid var(--border);
			padding: 4px 4px calc(4px + env(safe-area-inset-bottom));
			z-index: 30;
		}
		.tabbar a,
		.tabbar button {
			min-height: 50px;
			display: flex;
			flex-direction: column;
			align-items: center;
			justify-content: center;
			gap: 2px;
			text-decoration: none;
			color: var(--text-3);
			font-size: 0.6875rem;
			font-weight: 600;
			border: 0;
			background: transparent;
			cursor: pointer;
		}
		.tabbar [aria-current='page'] {
			color: var(--accent-text);
		}
		.tab-icon {
			position: relative;
			display: inline-flex;
		}
		.tab-badge {
			position: absolute;
			top: -5px;
			right: -12px;
			font-size: 0.625rem;
			background: var(--accent);
			color: var(--on-accent);
			border-radius: 999px;
			padding: 0 5px;
			line-height: 1rem;
		}
	}
	@media (max-width: 900px) {
		.app.focus .main-col {
			padding-top: 0.5rem;
		}
	}
</style>
