<script lang="ts">
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	let {
		open = $bindable(false),
		title,
		wide = false,
		onclose,
		children,
		footer
	}: {
		open?: boolean;
		title: string;
		wide?: boolean;
		onclose?: () => void;
		children: Snippet;
		footer?: Snippet;
	} = $props();

	let dialog: HTMLDialogElement | undefined = $state();

	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		if (!open && dialog.open) dialog.close();
	});

	function handleClose() {
		open = false;
		onclose?.();
	}

	function onBackdrop(e: MouseEvent) {
		if (e.target === dialog) handleClose();
	}
</script>

<dialog
	bind:this={dialog}
	class="modal"
	class:wide
	aria-labelledby="modal-title"
	onclose={handleClose}
	onclick={onBackdrop}
>
	{#if open}
		<div class="modal-head">
			<h2 id="modal-title">{title}</h2>
			<button type="button" class="icon-btn plain" aria-label="Close" onclick={handleClose}>
				<Icon name="x" />
			</button>
		</div>
		<div class="modal-body">
			{@render children()}
		</div>
		{#if footer}
			<div class="modal-foot">
				{@render footer()}
			</div>
		{/if}
	{/if}
</dialog>
