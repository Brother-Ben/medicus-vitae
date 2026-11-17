<script lang="ts" module>
	import { appearance } from '#lib/client/appearance.svelte.js';
	import { decorationFor, type Decoration } from '#lib/decor/calendar.js';

	// Seasonal and holiday decorations: a layer on top of the theme that never
	// changes its colors and never takes clicks. Falling and twinkling pieces stay
	// in the sidebar, or (Whole screen) drift faintly across all of it; while
	// studying, or with motion off, they go back to the sidebar so nothing sits over
	// what's being read. They hold still while studying, in the background, or with
	// reduced motion. Original artwork, drawn in SVG with the theme's own colors so
	// it suits every theme.

	let now = $state(new Date());
	let ticking = false;

	/** Which decoration shows now (a preview from Settings wins over the date). */
	export function activeDecoration(): Decoration | null {
		if (typeof window !== 'undefined' && !ticking) {
			ticking = true;
			setInterval(() => (now = new Date()), 60_000);
		}
		if (appearance.preview) return appearance.preview as Decoration;
		return decorationFor(now, appearance.account, appearance.theme);
	}
</script>

<script lang="ts">
	import { onMount } from 'svelte';

	/** overlay: drifting particles and corner pieces. sidebar-top / sidebar-foot / mobile-top: pieces placed in the app's chrome. */
	let { place, studying = false }: { place: 'overlay' | 'sidebar-top' | 'sidebar-foot' | 'mobile-top'; studying?: boolean } = $props();

	const active = $derived(appearance.focus ? null : activeDecoration());
	let hidden = $state(false);
	let reduced = $state(false);
	let width = $state(1440);
	let rem = $state(16);

	const still = $derived(appearance.account.motion === 'still' || reduced || appearance.device.reduceMotion);
	const paused = $derived(hidden || (appearance.account.pauseWhileStudying && studying));
	/** Across the whole screen only while they move and nothing is being studied. */
	const wide = $derived(appearance.account.decorSpread === 'screen' && !studying && !still);
	/** The sidebar's width (AppShell: 13.75rem open, 3.5rem folded to icons). */
	const sideWidth = $derived((appearance.device.sidebar === 'collapsed' ? 3.5 : 13.75) * rem);

	onMount(() => {
		const mq = matchMedia('(prefers-reduced-motion: reduce)');
		reduced = mq.matches;
		const onMq = () => (reduced = mq.matches);
		mq.addEventListener('change', onMq);
		const onVis = () => (hidden = document.hidden);
		document.addEventListener('visibilitychange', onVis);
		const onResize = () => {
			width = window.innerWidth;
			rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
		};
		onResize();
		window.addEventListener('resize', onResize);
		return () => {
			mq.removeEventListener('change', onMq);
			document.removeEventListener('visibilitychange', onVis);
			window.removeEventListener('resize', onResize);
		};
	});

	// A fixed random layout per decoration, so particles don't jump around on every change.
	function seeded(seed: number) {
		let s = seed;
		return () => {
			s = (s * 16807) % 2147483647;
			return (s - 1) / 2147483646;
		};
	}

	interface Particle {
		key: string;
		x: number;
		top: number;
		size: number;
		duration: number;
		delay: number;
		sway: number;
		variant: number;
		turn: number;
	}

	/** Twinkling in place (Ramadan stars, summer fireflies) rather than falling. */
	const twinkles = $derived(active === 'ramadan' || active === 'summer');

	/** Snow: winter's, and Christmas's when it falls across the whole screen (in the sidebar, Christmas has its lights and snowman). */
	const snowy = $derived(active === 'winter' || active === 'christmas');

	const particles = $derived.by((): Particle[] => {
		if (place !== 'overlay' || !active || (active === 'christmas' && !wide)) return [];
		const phone = width <= 900;
		const folded = appearance.device.sidebar === 'collapsed';
		let count: number;
		if (wide) count = active === 'thanksgiving' ? (phone ? 4 : 8) : phone ? 6 : 12;
		else if (phone) count = active === 'thanksgiving' ? 4 : twinkles ? 5 : 6;
		else count = active === 'thanksgiving' ? (folded ? 3 : 6) : folded ? 4 : 9;
		const mode = wide ? 'w' : phone ? 'p' : folded ? 'f' : 's';
		const rand = seeded(active.length * 7919 + mode.charCodeAt(0) * 31);
		// Where they can be: the whole width; on phones (no sidebar) the two side margins; else the sidebar.
		const bands: [number, number][] = wide ? [[8, width - 24]] : phone ? [[2, 12], [width - 14, width - 4]] : [[8, sideWidth - 32]];
		return Array.from({ length: count }, (_, i) => {
			const band = bands[i % 3 === 2 ? bands.length - 1 : 0];
			const base = phone ? 9 + rand() * 4 : snowy ? 7 + rand() * 7 : active === 'summer' ? 6 + rand() * 5 : active === 'spring' ? 10 + rand() * 7 : 13 + rand() * 9;
			return {
				key: `${mode}${i}`,
				x: band[0] + rand() * Math.max(1, band[1] - band[0]),
				top: rand() * 100,
				// Across the screen: a little smaller and slower, so they stay in the background.
				size: wide ? base * 0.8 : base,
				duration: wide ? 40 + rand() * 24 : 26 + rand() * 18,
				delay: -rand() * (wide ? 60 : 40),
				sway: 5 + rand() * 4,
				variant: Math.floor(rand() * 3),
				turn: rand() * 360
			};
		});
	});

	// Season themes set --decor-1/--decor-2 to their own colors; other themes fall back to theirs.
	const LEAF_COLORS = ['var(--decor-1, var(--weak))', 'var(--sec-cars)', 'var(--decor-2, var(--heat-1))'];
	const PETAL_COLORS = ['var(--decor-1, var(--sec-cars))', 'var(--decor-2, var(--hl-pink))', 'var(--decor-1, var(--sec-cars))'];
	const BULB_COLORS = ['var(--sec-cars)', 'var(--sec-bb)', 'var(--weak)', 'var(--sec-cp)'];
</script>

{#if active}
	{#if place === 'overlay'}
		<div class="decor-overlay" class:paused class:still class:wide aria-hidden="true">
			{#each particles as p (p.key)}
				<span
					class="particle"
					class:twinkle={twinkles}
					class:firefly={active === 'summer'}
					style:left="{p.x}px"
					style:top={still || twinkles ? `${p.top}%` : '-6%'}
					style:width="{p.size}px"
					style:height="{p.size}px"
					style:--duration="{p.duration}s"
					style:--delay="{p.delay}s"
					style:--sway="{p.sway}s"
				>
					<span class="sway" style:--turn="{p.turn}deg">
						{#if active === 'fall' || active === 'thanksgiving'}
							<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M12 2c4 3 7 7 6 12-1 4-4 6-6 8-2-2-5-4-6-8-1-5 2-9 6-12z" style="fill: {LEAF_COLORS[p.variant]}" /><path d="M12 5v16" style="stroke: var(--bg); stroke-width: 1.2; opacity: 0.6" /></svg>
						{:else if snowy}
							<svg viewBox="0 0 24 24" width="100%" height="100%" style="color: var(--decor-1, var(--text-3))"><g stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 2v20M3.3 7l17.4 10M3.3 17L20.7 7" /></g></svg>
						{:else if active === 'spring'}
							<!-- A cherry-blossom petal: round, with the little notch at its tip. -->
							<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M12 21c-5-2.5-8-6.5-7-11 .6-3 3-5 5-5 .9 0 1.6.5 2 1.2.4-.7 1.1-1.2 2-1.2 2 0 4.4 2 5 5 1 4.5-2 8.5-7 11z" style="fill: {PETAL_COLORS[p.variant]}" /></svg>
						{:else if active === 'summer'}
							<svg viewBox="0 0 24 24" width="100%" height="100%"><circle cx="12" cy="12" r="11" style="fill: var(--decor-2, var(--weak-soft)); opacity: 0.55" /><circle cx="12" cy="12" r="5" style="fill: var(--decor-1, var(--weak))" /></svg>
						{:else if active === 'ramadan'}
							<svg viewBox="0 0 24 24" width="100%" height="100%"><path d="M12 2l2.2 7.8L22 12l-7.8 2.2L12 22l-2.2-7.8L2 12l7.8-2.2z" style="fill: var(--weak)" /></svg>
						{/if}
					</span>
				</span>
			{/each}

			{#if active === 'ramadan'}
				<svg class="moon" viewBox="0 0 32 32"><path d="M21 4a12 12 0 1 0 7 21A10 10 0 1 1 21 4z" style="fill: var(--weak)" /></svg>
			{:else if active === 'thanksgiving' && width <= 900}
				<span class="corner-turkey">{@render turkey()}</span>
			{/if}
		</div>
	{:else if place === 'sidebar-top' || place === 'mobile-top'}
		{#if active === 'christmas'}
			<svg class="lights" class:mobile={place === 'mobile-top'} class:paused class:still viewBox="0 0 220 26" preserveAspectRatio="none" aria-hidden="true">
				<path d="M0 6 Q 27 18 55 6 T 110 6 T 165 6 T 220 6" style="fill: none; stroke: var(--text-3); stroke-width: 1" />
				{#each Array.from({ length: 10 }, (_, i) => i) as i (i)}
					{@const x = 11 + i * 22}
					{@const y = 6 + 6 * Math.abs(Math.sin(((x % 55) / 55) * Math.PI))}
					<g class="bulb" style:--delay="{-(i * 0.7) % 4}s">
						<rect x={x - 1.5} y={y - 1} width="3" height="3" rx="0.5" style="fill: var(--text-3)" />
						<ellipse cx={x} cy={y + 5} rx="3.2" ry="4.4" style="fill: {BULB_COLORS[i % 4]}" />
					</g>
				{/each}
			</svg>
		{:else if active === 'ramadan'}
			<svg class="lanterns" class:mobile={place === 'mobile-top'} class:paused class:still viewBox="0 0 220 60" aria-hidden="true">
				{#each [36, 110, 184] as x, i (x)}
					{@const len = i === 1 ? 26 : 14}
					<g class="lantern" style:--delay="{-i * 1.3}s" style="transform-origin: {x}px 0">
						<line x1={x} y1="0" x2={x} y2={len} style="stroke: var(--border-strong); stroke-width: 1" />
						<path d="M{x - 5} {len + 3} h10 l3 6 v11 l-3 5 h-10 l-3 -5 v-11 z" style="fill: var(--weak); opacity: 0.85" />
						<rect x={x - 4} y={len + 10} width="8" height="9" rx="1.5" style="fill: var(--weak-soft)" />
						<path d="M{x - 4} {len} h8 l-1 3 h-6 z" style="fill: var(--weak-text)" />
					</g>
				{/each}
			</svg>
		{/if}
	{:else if place === 'sidebar-foot'}
		{#if active === 'spring'}
			<svg class="sprig" viewBox="0 0 48 40" aria-hidden="true">
				<path d="M4 38 Q 18 30 26 18 T 44 4" style="fill: none; stroke: var(--text-3); stroke-width: 1.6; stroke-linecap: round" />
				<path d="M20 25 q 4 -6 10 -5 q -3 6 -10 5z" style="fill: var(--accent); opacity: 0.8" />
				{#each [[26, 17], [36, 9], [14, 30]] as [x, y], i (i)}
					<g transform="translate({x} {y})">
						{#each [0, 72, 144, 216, 288] as r (r)}<ellipse cx="0" cy="-3.2" rx="2.4" ry="3.2" transform="rotate({r})" style="fill: var(--decor-2, var(--hl-pink))" />{/each}
						<circle r="1.4" style="fill: var(--decor-1, var(--sec-cars))" />
					</g>
				{/each}
			</svg>
		{:else if active === 'summer'}
			<svg class="sprig" viewBox="0 0 48 40" aria-hidden="true">
				<circle cx="32" cy="14" r="7" style="fill: var(--decor-1, var(--weak))" />
				{#each [0, 45, 90, 135, 180, 225, 270, 315] as r (r)}<path d="M32 3.5v-2.5" transform="rotate({r} 32 14)" style="stroke: var(--decor-1, var(--weak)); stroke-width: 1.6; stroke-linecap: round" />{/each}
				<path d="M2 32 q 6 -5 12 0 t 12 0 t 12 0 t 10 0" style="fill: none; stroke: var(--accent); stroke-width: 1.8; stroke-linecap: round" />
				<path d="M8 38 q 6 -5 12 0 t 12 0 t 12 0" style="fill: none; stroke: var(--accent); stroke-width: 1.4; stroke-linecap: round; opacity: 0.6" />
			</svg>
		{:else if active === 'christmas'}
			<svg class="snowman" viewBox="0 0 40 52" aria-hidden="true">
				<circle cx="20" cy="38" r="12" style="fill: var(--on-ink); stroke: var(--text-3); stroke-width: 1" />
				<circle cx="20" cy="19" r="8.5" style="fill: var(--on-ink); stroke: var(--text-3); stroke-width: 1" />
				<rect x="13" y="6" width="14" height="3" rx="1" style="fill: var(--ink)" />
				<rect x="15.5" y="0" width="9" height="7" rx="1" style="fill: var(--ink)" />
				<path d="M13 25.5 q7 4 14 0 l1 3 q-8 4 -16 0 z" style="fill: var(--sec-cars)" />
				<circle cx="17" cy="17.5" r="1.1" style="fill: var(--ink)" />
				<circle cx="23" cy="17.5" r="1.1" style="fill: var(--ink)" />
				<path d="M20 19.5 l6 1.5 l-6 1 z" style="fill: var(--weak)" />
				<circle cx="20" cy="34" r="1" style="fill: var(--ink)" />
				<circle cx="20" cy="39" r="1" style="fill: var(--ink)" />
			</svg>
		{:else if active === 'thanksgiving'}
			<span class="foot-turkey">{@render turkey()}</span>
		{/if}
	{/if}
{/if}

{#snippet turkey()}
	<svg viewBox="0 0 48 44" width="100%" height="100%" aria-hidden="true">
		<g style="stroke: var(--bg); stroke-width: 1">
			<ellipse cx="14" cy="18" rx="6" ry="14" transform="rotate(-50 24 26)" style="fill: var(--sec-cars)" />
			<ellipse cx="18" cy="14" rx="6" ry="14" transform="rotate(-22 24 26)" style="fill: var(--weak)" />
			<ellipse cx="24" cy="12" rx="6" ry="14" style="fill: var(--heat-1)" />
			<ellipse cx="30" cy="14" rx="6" ry="14" transform="rotate(22 24 26)" style="fill: var(--weak)" />
			<ellipse cx="34" cy="18" rx="6" ry="14" transform="rotate(50 24 26)" style="fill: var(--sec-cars)" />
		</g>
		<ellipse cx="24" cy="30" rx="11" ry="10" style="fill: var(--weak-text)" />
		<circle cx="24" cy="19" r="6" style="fill: var(--weak-text)" />
		<circle cx="22" cy="18" r="1" style="fill: var(--on-ink)" />
		<circle cx="26" cy="18" r="1" style="fill: var(--on-ink)" />
		<path d="M24 20 l3 2 l-3 1 z" style="fill: var(--weak)" />
		<path d="M23.5 22 q-1 4 1 5" style="fill: none; stroke: var(--sec-cars); stroke-width: 1.6; stroke-linecap: round" />
		<path d="M19 39 v4 M29 39 v4" style="stroke: var(--weak); stroke-width: 1.6; stroke-linecap: round" />
	</svg>
{/snippet}

<style>
	.decor-overlay {
		position: fixed;
		inset: 0;
		pointer-events: none;
		z-index: 15;
		overflow: hidden;
	}
	.particle {
		position: absolute;
		display: block;
		opacity: calc(0.5 * var(--dim, 1));
		animation: decor-fall var(--duration) linear var(--delay) infinite;
	}
	/* Across the whole screen they pass over the page itself, so they're fainter. */
	.decor-overlay.wide .particle {
		--dim: 0.6;
	}
	.particle .sway {
		display: block;
		width: 100%;
		height: 100%;
		transform: rotate(var(--turn));
		animation: decor-sway var(--sway) ease-in-out var(--delay) infinite alternate;
	}
	.particle.twinkle {
		animation: decor-twinkle var(--sway) ease-in-out var(--delay) infinite alternate;
		opacity: calc(0.35 * var(--dim, 1));
	}
	.particle.twinkle .sway {
		animation: none;
	}
	/* Fireflies drift a little as they glow. */
	.particle.firefly {
		opacity: calc(0.4 * var(--dim, 1));
	}
	.particle.firefly .sway {
		animation: decor-drift calc(var(--sway) * 2.2) ease-in-out var(--delay) infinite alternate;
	}
	@keyframes decor-drift {
		from {
			transform: translate(-6px, 4px);
		}
		to {
			transform: translate(6px, -8px);
		}
	}
	.sprig {
		display: block;
		width: 48px;
		height: 40px;
		margin: 0 0.5rem -0.25rem auto;
		pointer-events: none;
	}
	@keyframes decor-fall {
		from {
			transform: translateY(0);
		}
		to {
			transform: translateY(112vh);
		}
	}
	@keyframes decor-sway {
		from {
			transform: translateX(-10px) rotate(calc(var(--turn) - 25deg));
		}
		to {
			transform: translateX(10px) rotate(calc(var(--turn) + 25deg));
		}
	}
	/* Slow and soft: one fade every few seconds, far below any flashing threshold. */
	@keyframes decor-twinkle {
		from {
			opacity: calc(0.15 * var(--dim, 1));
		}
		to {
			opacity: calc(0.55 * var(--dim, 1));
		}
	}
	.moon {
		position: absolute;
		top: 8px;
		right: 8px;
		width: 26px;
		height: 26px;
		opacity: 0.8;
	}
	.corner-turkey {
		position: absolute;
		left: 6px;
		bottom: calc(76px + env(safe-area-inset-bottom));
		width: 34px;
		height: 32px;
		opacity: 0.9;
	}
	.lights {
		display: block;
		width: 100%;
		height: 26px;
		pointer-events: none;
	}
	.lights .bulb {
		animation: decor-glow 3.5s ease-in-out var(--delay) infinite alternate;
	}
	@keyframes decor-glow {
		from {
			opacity: 0.55;
		}
		to {
			opacity: 1;
		}
	}
	.lanterns {
		display: block;
		width: 100%;
		height: 60px;
		pointer-events: none;
	}
	/* Phones: in the header's empty middle, clear of the logo and buttons. */
	.lanterns.mobile {
		width: 84px;
		height: 30px;
		margin: 0 auto;
	}
	.lights.mobile {
		height: 9px;
	}
	.lanterns .lantern {
		animation: decor-swing 6s ease-in-out var(--delay) infinite alternate;
	}
	@keyframes decor-swing {
		from {
			transform: rotate(-3deg);
		}
		to {
			transform: rotate(3deg);
		}
	}
	.snowman {
		display: block;
		width: 34px;
		height: 44px;
		margin: 0 0.5rem -0.5rem auto;
		pointer-events: none;
	}
	.foot-turkey {
		display: block;
		width: 44px;
		height: 40px;
		margin: 0 0.5rem -0.25rem auto;
		pointer-events: none;
	}
	.paused,
	.paused :global(*) {
		animation-play-state: paused !important;
	}
	.still,
	.still :global(*) {
		animation: none !important;
	}
</style>
