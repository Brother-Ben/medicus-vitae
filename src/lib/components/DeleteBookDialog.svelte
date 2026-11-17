<script lang="ts">
	import { api } from '#lib/client/api.js';
	import { toast, toastAction, toastError } from '#lib/client/toast.svelte.js';
	import ConfirmDialog from './ConfirmDialog.svelte';

	// Deleting a book: what goes, whether its cards go too, and an Undo that
	// restores the snapshot taken just before.

	let {
		open = $bindable(false),
		bookId,
		title,
		ondeleted
	}: { open?: boolean; bookId: string; title: string; ondeleted?: () => void } = $props();

	let preview = $state<{ highlights: number; notes: number; cards: number; links: number } | null>(null);
	let deleteCards = $state(false);

	$effect(() => {
		if (!open) return;
		preview = null;
		deleteCards = false;
		api<typeof preview>(`/api/library/${bookId}?delete`)
			.then((p) => (preview = p))
			.catch(() => (preview = { highlights: 0, notes: 0, cards: 0, links: 0 }));
	});

	const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;

	async function remove() {
		const r = await api<{ snapshotId: string; cardsDeleted: number }>(`/api/library/${bookId}`, { method: 'DELETE', body: { deleteCards } });
		ondeleted?.();
		toastAction(`Deleted “${title}”${r.cardsDeleted ? ` and ${plural(r.cardsDeleted, 'card')}` : ''}`, {
			label: 'Undo',
			run: async () => {
				try {
					await api('/api/sync', { body: { action: 'restore-snapshot', id: r.snapshotId } });
					toast('Book restored');
					location.reload();
				} catch (err) {
					toastError(err);
				}
			}
		});
	}
</script>

<ConfirmDialog bind:open title="Delete this book?" confirmLabel="Delete book" onconfirm={remove}>
	<p><strong>{title}</strong> will be removed from your library{preview ? ':' : '.'}</p>
	{#if preview}
		<ul class="small what">
			<li>its pages, chapters and progress</li>
			{#if preview.highlights}<li>{plural(preview.highlights, 'highlight')}</li>{/if}
			{#if preview.notes}<li>{plural(preview.notes, 'reading note')} written on it</li>{/if}
			{#if preview.links}<li>{plural(preview.links, 'link')} to Anki decks (the cards stay as they are)</li>{/if}
		</ul>
		{#if preview.cards}
			<label class="checkbox">
				<input type="checkbox" bind:checked={deleteCards} />
				Also delete the {plural(preview.cards, 'card')} made from it
			</label>
			{#if !deleteCards}<p class="hint">Kept cards stay in your reviews and keep a copy of their passage.</p>{/if}
		{/if}
	{/if}
	<p class="hint">A snapshot is taken first: Undo right after, or restore it later from Settings › Backups &amp; sync.</p>
</ConfirmDialog>

<style>
	.what {
		margin: 0;
		padding-left: 1.25rem;
		color: var(--text-2);
	}
</style>
