<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';
	import Modal from './Modal.svelte';

	// "Are you sure?" for anything that removes or changes a lot at once. The
	// confirm button stays busy while the work runs; errors show in the dialog.

	let {
		open = $bindable(false),
		title,
		confirmLabel = 'Delete',
		danger = true,
		disabled = false,
		onconfirm,
		children
	}: {
		open?: boolean;
		title: string;
		confirmLabel?: string;
		danger?: boolean;
		/** Keeps the confirm button off (e.g. until a name is typed). */
		disabled?: boolean;
		onconfirm: () => void | Promise<void>;
		children?: Snippet;
	} = $props();

	let busy = $state(false);
	let error = $state('');

	$effect(() => {
		if (open) error = '';
	});

	async function go() {
		busy = true;
		error = '';
		try {
			await onconfirm();
			open = false;
		} catch (err) {
			error = err instanceof Error ? err.message : String(err);
		} finally {
			busy = false;
		}
	}
</script>

<Modal bind:open {title}>
	<div class="stack-sm confirm-body">
		{@render children?.()}
	</div>
	{#if error}<div class="error-box" role="alert"><Icon name="alert" size={16} />{error}</div>{/if}
	{#snippet footer()}
		<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
		<button type="button" class={danger ? 'btn btn-danger-solid' : 'btn btn-primary'} disabled={busy || disabled} onclick={go}>
			{busy ? 'Working…' : confirmLabel}
		</button>
	{/snippet}
</Modal>

<style>
	.confirm-body :global(p) {
		color: var(--text-2);
	}
</style>
