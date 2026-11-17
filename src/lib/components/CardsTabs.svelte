<script lang="ts">
	import { page } from '$app/state';

	// The Flashcards area's sections.
	let { carsWaiting = 0 }: { carsWaiting?: number } = $props();
	const path = $derived(page.url.pathname);
</script>

<nav class="tabs" aria-label="Flashcards sections">
	<a href="/cards" aria-current={path === '/cards' || path.startsWith('/cards/import') ? 'page' : undefined}>Cards &amp; decks</a>
	<a href="/cards/cars" aria-current={path.startsWith('/cards/cars') ? 'page' : undefined}>CARS{#if carsWaiting}<span class="count">{carsWaiting}</span>{/if}</a>
	<a href="/cards/types" aria-current={path.startsWith('/cards/types') ? 'page' : undefined}>Card types</a>
</nav>
