<script lang="ts">
	import { CATEGORY_SHORT, sectionOf } from '#lib/aamc.js';

	// An AAMC category or CARS skill code, with its section's color bar beside it.
	let { code, title = CATEGORY_SHORT[code] ?? '' }: { code: string; title?: string } = $props();
</script>

<span class="code-tag" {title}><span class="sec-bar" data-sec={sectionOf(code) ?? ''} aria-hidden="true"></span>{code}</span>
