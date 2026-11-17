<script lang="ts">
	import Logo from '#lib/components/Logo.svelte';
	import type { LayoutProps } from './$types';

	let { children }: LayoutProps = $props();
</script>

<div class="auth-wrap">
	<div class="auth-brand">
		<Logo size={36} />
		<span class="brand-name"><strong>Medicus</strong> <span class="brand-second">Vitae</span></span>
	</div>
	{@render children()}
</div>

<style>
	.auth-wrap {
		min-height: 100vh;
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 3rem 1rem 4rem;
		gap: 1.75rem;
	}
	.auth-brand {
		display: flex;
		align-items: center;
		gap: 0.625rem;
	}
	.brand-name {
		font-size: 1.25rem;
		letter-spacing: -0.01em;
	}
	.brand-name strong {
		font-weight: 700;
	}
	.brand-second {
		font-weight: 400;
		color: var(--text-2);
	}
	:global(.auth-card) {
		width: min(30rem, 100%);
	}
	:global(.auth-card.wide) {
		width: min(42rem, 100%);
	}
</style>
