<script lang="ts">
	import { onMount } from 'svelte';
	import { frameRuntime } from '#lib/anki-frame-runtime.js';
	import { cardStore, persistCardStore, type CardStore } from '#lib/client/card-store.js';

	// Shows one side of a card imported from Anki in its own frame, with the
	// deck's styling and scripts, the way Anki's reviewer shows it. The frame is
	// sandboxed without allow-same-origin: it gets an opaque origin, so the deck's
	// scripts run but can't touch this page, Cortex's storage or the sign-in.
	// Media loads through the daily media key (the frame sends no cookies), and
	// the frame reports its height and key presses by postMessage.

	let {
		html,
		css = '',
		math = false,
		ord = 0,
		label = 'Card',
		mediaBase = '/api/media/',
		onreveal
	}: {
		html: string;
		css?: string;
		math?: boolean;
		ord?: number;
		label?: string;
		mediaBase?: string;
		onreveal?: () => void;
	} = $props();

	let frame: HTMLIFrameElement | undefined = $state();
	let mounted = $state(false);
	let height = $state(160);
	let ownBackground = $state(false);
	// Filled from the theme's tokens before the frame is drawn (readTheme, on mount); these are only placeholders.
	let theme = $state({ dark: false, text: 'CanvasText', accent: 'LinkText', muted: 'GrayText', border: 'GrayText', surface: 'Canvas', warn: 'CanvasText', font: 'system-ui, sans-serif', mono: 'ui-monospace, monospace', scale: 1 });
	const nonce = Math.random().toString(36).slice(2) + Date.now().toString(36);

	function readTheme() {
		const root = document.documentElement;
		const s = getComputedStyle(root);
		const v = (name: string, fallback: string) => s.getPropertyValue(name).trim() || fallback;
		theme = {
			dark: s.colorScheme.includes('dark'),
			text: v('--text', theme.text),
			accent: v('--accent-text', theme.accent),
			muted: v('--text-3', theme.muted),
			border: v('--border', theme.border),
			surface: v('--surface-2', theme.surface),
			warn: v('--weak-text', theme.warn),
			font: v('--font-ui', theme.font),
			mono: v('--font-mono', theme.mono),
			scale: Number(v('--text-scale', '1')) || 1
		};
	}

	const safeCss = $derived(css.replace(/<\/style/gi, '<\\/style'));

	const doc = $derived.by(() => {
		const origin = typeof location === 'undefined' ? '' : location.origin;
		// A copy of what card scripts saved so far (the frame reports its own changes).
		const saved = JSON.parse(JSON.stringify(cardStore)) as CardStore;
		const runtime = frameRuntime({ nonce, dark: theme.dark, text: theme.text, store: saved }).replace(/<\/script/gi, '<\\/script');
		return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<base href="${origin}${mediaBase}" target="_blank">
${math ? `<link rel="stylesheet" href="${origin}/katex/katex.min.css">` : ''}
<style>
:root { color-scheme: ${theme.dark ? 'dark' : 'light'}; }
html { zoom: ${theme.scale}; }
html, body { margin: 0; padding: 0; }
body { font-family: ${theme.font}; font-size: 20px; line-height: 1.5; color: ${theme.text}; overflow-wrap: anywhere; padding: 4px; }
.cloze { font-weight: 700; color: ${theme.accent}; }
img { max-width: 100%; height: auto; }
audio.sound { display: block; margin: 0.5rem auto; max-width: 100%; }
details.hint { margin-top: 0.5rem; } details.hint summary { cursor: pointer; color: ${theme.accent}; }
.typed-answer { display: inline-block; font-family: ${theme.mono}; padding: 0.375rem 0.75rem; border-radius: 8px; background: ${theme.surface}; }
.card-problem { color: ${theme.warn}; font-size: 1rem; }
pre.latex { white-space: pre-wrap; font-size: 0.875rem; color: ${theme.muted}; }
hr#answer { border: 0; border-top: 1px solid ${theme.border}; margin: 1rem 0; }
a { color: ${theme.accent}; }
</style>
<style>${safeCss}</style>
<script>${runtime}<\/script>
</head><body class="card card${ord + 1}${theme.dark ? ' nightMode night_mode' : ''}">${html}</body></html>`;
	});

	function onMessage(e: MessageEvent) {
		if (!frame || e.source !== frame.contentWindow) return;
		const m = e.data as { cortexCard?: string; op?: string; [k: string]: unknown } | null;
		if (!m || m.cortexCard !== nonce) return;
		if (m.op === 'size') {
			const h = Number(m.height);
			if (Number.isFinite(h)) height = Math.min(Math.max(Math.round(h), 40), 20000);
		} else if (m.op === 'key' && typeof m.key === 'string') {
			// Keys pressed while the card has focus still reach the review shortcuts.
			window.dispatchEvent(
				new KeyboardEvent('keydown', { key: m.key, code: String(m.code ?? ''), ctrlKey: !!m.ctrlKey, metaKey: !!m.metaKey, shiftKey: !!m.shiftKey, altKey: !!m.altKey })
			);
		} else if (m.op === 'reveal') {
			onreveal?.();
		} else if (m.op === 'style') {
			ownBackground = !!m.own;
		} else if (m.op === 'store' && (m.kind === 'localStorage' || m.kind === 'sessionStorage') && typeof m.key === 'string') {
			const bucket = cardStore[m.kind];
			if (m.value === null) delete bucket[m.key];
			else bucket[m.key] = String(m.value).slice(0, 100_000);
			if (m.kind === 'localStorage') persistCardStore();
		} else if (m.op === 'store-clear' && (m.kind === 'localStorage' || m.kind === 'sessionStorage')) {
			cardStore[m.kind] = {};
			if (m.kind === 'localStorage') persistCardStore();
		}
	}

	onMount(() => {
		readTheme();
		mounted = true;
		const mo = new MutationObserver(() => readTheme());
		mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'style', 'data-reading-font'] });
		window.addEventListener('message', onMessage);
		return () => {
			mo.disconnect();
			window.removeEventListener('message', onMessage);
		};
	});
</script>

{#if mounted}
	<iframe
		bind:this={frame}
		class="anki-card"
		class:own-bg={ownBackground}
		title={label}
		sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
		srcdoc={doc}
		style:height="{height}px"
		style:color-scheme={theme.dark ? 'dark' : 'light'}
	></iframe>
{:else}
	<div class="anki-card placeholder" style:height="{height}px" aria-hidden="true"></div>
{/if}

<style>
	/* The frame's color-scheme matches its page's (set inline), or the browser would
	   paint an opaque backdrop behind cards that blend into the theme. */
	.anki-card {
		display: block;
		width: 100%;
		border: 0;
		background: transparent;
	}
	/* A deck with its own card color shows it as a card, as Anki does. */
	.anki-card.own-bg {
		border-radius: var(--radius-lg);
	}
</style>
