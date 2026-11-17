<script lang="ts">
	// The app's mark. The final logo is on hold: for now a rounded square with an
	// "M". Replace this one component to change it everywhere in the app (the
	// favicon, app icons and the Windows tray icon are drawn by
	// static/favicon.svg and desktop/make-icons.ps1).
	let { size = 32 }: { size?: number } = $props();
</script>

<span class="logo-mark" aria-hidden="true" style:width="{size}px" style:height="{size}px" style:font-size="{size * 0.53}px" style:border-radius="{size * 0.25}px">M</span>

<style>
	.logo-mark {
		background: var(--accent);
		color: var(--on-accent);
		display: inline-flex;
		align-items: center;
		justify-content: center;
		font-weight: 700;
		letter-spacing: -0.02em;
		line-height: 1;
		flex: none;
	}
</style>
