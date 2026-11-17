<script lang="ts">
	import Icon from './Icon.svelte';

	// The Tutor area's sections.
	let { current, pending = 0, quizCount = 0 }: { current: 'ask' | 'research' | 'queue' | 'quiz'; pending?: number; quizCount?: number } = $props();
</script>

<nav class="tabs" aria-label="Tutor sections">
	<a href="/tutor" aria-current={current === 'ask' ? 'page' : undefined}>Ask</a>
	<a href="/tutor?mode=research" aria-current={current === 'research' ? 'page' : undefined}><Icon name="globe" size={14} />Research the web</a>
	<a href="/tutor/queue" aria-current={current === 'queue' ? 'page' : undefined}>Approvals{#if pending}<span class="count">{pending}</span>{/if}</a>
	<a href="/quiz" aria-current={current === 'quiz' ? 'page' : undefined}>Quiz{#if quizCount}<span class="count">{quizCount}</span>{/if}</a>
</nav>
