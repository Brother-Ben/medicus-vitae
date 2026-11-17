<script lang="ts">
	import { onMount } from 'svelte';
	import { appearance } from '#lib/client/appearance.svelte.js';
	import { openBook } from '#lib/reader/pdfjs.js';

	let {
		documentId,
		page,
		rect,
		maxWidth = 560,
		alt = 'Figure from the book'
	}: { documentId: string; page: number; rect: number[]; maxWidth?: number; alt?: string } = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	let status = $state<'loading' | 'ok' | 'error'>('loading');
	let cssWidth = $state(0);

	onMount(() => {
		let cancelled = false;
		(async () => {
			try {
				const doc = await openBook(documentId);
				const p = await doc.getPage(page);
				const base = p.getViewport({ scale: 1 });
				const [x0, y0, x1, y1] = rect;
				const regionWidth = Math.max(1, (x1 - x0) * base.width);
				const dpr = Math.min(3, window.devicePixelRatio || 1);
				const fit = Math.min(3, maxWidth / regionWidth);
				const vp = p.getViewport({ scale: fit * dpr });
				if (cancelled || !canvas) return;
				canvas.width = Math.max(1, Math.ceil((x1 - x0) * vp.width));
				canvas.height = Math.max(1, Math.ceil((y1 - y0) * vp.height));
				cssWidth = Math.round(canvas.width / dpr);
				await p.render({ canvas, viewport: vp, transform: [1, 0, 0, 1, -x0 * vp.width, -y0 * vp.height] }).promise;
				if (!cancelled) status = 'ok';
			} catch {
				if (!cancelled) status = 'error';
			}
		})();
		return () => {
			cancelled = true;
		};
	});
</script>

<!-- A crop of a book page: shown in the reader's page style (Settings › Appearance). -->
<figure class="region" data-page={appearance.pageStyle}>
	<div class="pdf-page"><canvas bind:this={canvas} aria-hidden="true" style:width={cssWidth ? `${cssWidth}px` : undefined} class:hidden={status !== 'ok'}></canvas></div>
	{#if status === 'loading'}<div class="placeholder small muted">Loading figure…</div>{/if}
	{#if status === 'error'}<div class="placeholder small muted">The figure couldn’t be shown (the book file may be missing).</div>{/if}
	<figcaption class="sr-only">{alt}</figcaption>
</figure>

<style>
	.region {
		margin: 0;
		max-width: 100%;
	}
	canvas {
		max-width: 100%;
		height: auto;
		border-radius: 8px;
		border: 1px solid var(--border);
		background: var(--page-bg);
		display: block;
	}
	.hidden {
		display: none;
	}
	.placeholder {
		padding: 1rem;
		border: 1px dashed var(--border-strong);
		border-radius: 8px;
	}
</style>
