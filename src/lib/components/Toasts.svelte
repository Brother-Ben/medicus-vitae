<script lang="ts">
	import { dismiss, toasts, type Toast } from '#lib/client/toast.svelte.js';
	import Icon from './Icon.svelte';

	async function run(t: Toast) {
		dismiss(t.id);
		await t.action?.run();
	}
</script>

<div class="toasts" role="status" aria-live="polite">
	{#each toasts as t (t.id)}
		<div class="toast" class:error={t.kind === 'error'}>
			<span style="flex: 1 1 auto">{t.message}</span>
			{#if t.action}
				<button type="button" class="toast-action" onclick={() => run(t)}>{t.action.label}</button>
			{/if}
			<button type="button" class="icon-btn plain toast-x" aria-label="Dismiss" onclick={() => dismiss(t.id)}>
				<Icon name="x" size={16} />
			</button>
		</div>
	{/each}
</div>

<style>
	.toast-action {
		border: 0;
		background: transparent;
		color: inherit;
		font: inherit;
		font-weight: 700;
		text-decoration: underline;
		text-underline-offset: 3px;
		cursor: pointer;
		padding: 0.25rem 0.375rem;
		border-radius: var(--radius-sm);
	}
	.toast-action:hover {
		background: color-mix(in srgb, currentColor 12%, transparent);
	}
	.toast-x {
		color: inherit;
		width: 28px;
		height: 28px;
	}
</style>
