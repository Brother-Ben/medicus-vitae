<script lang="ts">
	import LayoutEditor from '#lib/components/LayoutEditor.svelte';
	import { appearance, setAccountAppearance, setDeviceAppearance } from '#lib/client/appearance.svelte.js';
	import { DEFAULT_HOME, DEFAULT_NAV, HOME_SECTIONS, NAV_ITEMS } from '#lib/appearance.js';

	const navMeta = Object.fromEntries(
		NAV_ITEMS.map((n) => [n.id, { name: n.label, icon: n.icon as string, note: n.id === 'tutor' ? 'shown once an AI service is connected' : undefined }])
	);
	const homeMeta = Object.fromEntries(HOME_SECTIONS.map((s) => [s.id, { name: s.name, hint: s.hint }]));
	const shown = $derived(appearance.account.nav.filter((n) => n.visible).length);
</script>

<svelte:head><title>Menu & Today · Settings · Medicus Vitae</title></svelte:head>

<section class="card stack">
	<div class="card-header">
		<div>
			<h2>Menu</h2>
			<p class="card-sub">Hide what you don’t use and put the rest in your order. Settings always stays. On a phone, the first four become the tab bar.</p>
		</div>
		<button type="button" class="btn btn-sm btn-ghost" onclick={() => setAccountAppearance({ nav: DEFAULT_NAV.map((n) => ({ ...n })) })}>Reset</button>
	</div>
	<LayoutEditor label="Menu items" items={appearance.account.nav} meta={navMeta} onchange={(nav) => setAccountAppearance({ nav })} />
	{#if !shown}<p class="hint">Everything is hidden: only Settings shows in the menu. Today is still at the logo.</p>{/if}
	<div class="setting">
		<div>
			<div class="setting-title">Fold the sidebar to icons</div>
			<div class="setting-hint">On this device. You can also press <span class="kbd">[</span> anywhere, or use the button at the top of the sidebar.</div>
		</div>
		<input
			type="checkbox"
			class="switch"
			aria-label="Fold the sidebar to icons"
			checked={appearance.device.sidebar === 'collapsed'}
			onchange={(e) => setDeviceAppearance({ sidebar: (e.currentTarget as HTMLInputElement).checked ? 'collapsed' : 'expanded' })}
		/>
	</div>
</section>

<section class="card stack">
	<div class="card-header">
		<div>
			<h2>Today page</h2>
			<p class="card-sub">Pick what Today shows and in what order. Turned-off sections are one switch away.</p>
		</div>
		<button type="button" class="btn btn-sm btn-ghost" onclick={() => setAccountAppearance({ home: DEFAULT_HOME.map((h) => ({ ...h })) })}>Reset</button>
	</div>
	<LayoutEditor label="Today sections" items={appearance.account.home} meta={homeMeta} onchange={(home) => setAccountAppearance({ home })} />
</section>
