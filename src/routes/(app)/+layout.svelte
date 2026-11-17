<script lang="ts">
	import AppShell from '#lib/components/AppShell.svelte';
	import type { LayoutProps } from './$types';

	let { data, children }: LayoutProps = $props();
</script>

<AppShell shell={data.shell}>
	{@render children()}
</AppShell>
