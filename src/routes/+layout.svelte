<script lang="ts">
	import '@fontsource-variable/dm-sans';
	import '@fontsource-variable/jetbrains-mono';
	import '@fontsource-variable/source-serif-4';
	import '@fontsource-variable/atkinson-hyperlegible-next';
	import '#lib/styles/themes.css';
	import '#lib/styles/app.css';
	import { onMount } from 'svelte';
	import Toasts from '#lib/components/Toasts.svelte';
	import { initAppearance } from '#lib/client/appearance.svelte.js';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();

	onMount(() => initAppearance());
</script>

<svelte:head>
	<title>Medicus Vitae</title>
</svelte:head>

{@render children()}
<Toasts />
