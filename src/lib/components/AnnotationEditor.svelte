<script lang="ts">
	import { api } from '#lib/client/api.js';
	import { toast } from '#lib/client/toast.svelte.js';
	import { relativeTime } from '#lib/dates.js';
	import { renderMarkdown } from '#lib/markdown.js';
	import type { AnchorInputClient } from '#lib/reader/anchors.js';
	import Icon from './Icon.svelte';
	import Modal from './Modal.svelte';

	let {
		open = $bindable(false),
		annotationId = null,
		body = '',
		quote = '',
		anchor = null,
		anchorId = null,
		documentId = null,
		onsaved,
		ondeleted
	}: {
		open?: boolean;
		annotationId?: string | null;
		body?: string;
		quote?: string;
		anchor?: AnchorInputClient | null;
		anchorId?: string | null;
		documentId?: string | null;
		onsaved?: () => void;
		ondeleted?: () => void;
	} = $props();

	let text = $state('');
	let tab = $state<'write' | 'preview' | 'history'>('write');
	let saving = $state(false);
	let error = $state('');
	let revisions = $state<{ rev: number; body: string; createdAt: number }[]>([]);

	$effect(() => {
		if (!open) return;
		text = body;
		tab = 'write';
		error = '';
		revisions = [];
	});

	async function loadHistory() {
		tab = 'history';
		if (!annotationId) return;
		try {
			const r = await api<{ revisions: { rev: number; body: string; createdAt: number }[] }>(`/api/annotations?id=${annotationId}`);
			revisions = r.revisions;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}

	async function save() {
		if (!text.trim()) {
			error = 'Write something first.';
			return;
		}
		saving = true;
		error = '';
		try {
			if (annotationId) await api('/api/annotations', { method: 'PATCH', body: { id: annotationId, body: text } });
			else await api('/api/annotations', { body: { body: text, anchor, anchorId, documentId } });
			toast('Note saved');
			open = false;
			onsaved?.();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			saving = false;
		}
	}

	async function remove() {
		if (!annotationId || !confirm('Delete this note?')) return;
		try {
			await api('/api/annotations', { method: 'PATCH', body: { id: annotationId, delete: true } });
			toast('Note deleted');
			open = false;
			ondeleted?.();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	}
</script>

<Modal bind:open title={annotationId ? 'Edit note' : 'New note'}>
	{#if quote}
		<blockquote class="quote reading">{quote}</blockquote>
	{/if}
	<div class="segmented" role="tablist" aria-label="Note view">
		<button type="button" role="tab" aria-selected={tab === 'write'} onclick={() => (tab = 'write')}>Write</button>
		<button type="button" role="tab" aria-selected={tab === 'preview'} onclick={() => (tab = 'preview')}>Preview</button>
		{#if annotationId}<button type="button" role="tab" aria-selected={tab === 'history'} onclick={loadHistory}>History</button>{/if}
	</div>
	{#if tab === 'write'}
		<div class="field">
			<label for="note-body" class="sr-only">Note</label>
			<!-- svelte-ignore a11y_autofocus -->
			<textarea
				id="note-body"
				class="textarea reading"
				rows="7"
				bind:value={text}
				autofocus
				placeholder="Your note. Markdown works: **bold**, *italic*, - lists"
				onkeydown={(e) => {
					if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
						e.preventDefault();
						void save();
					}
				}}
			></textarea>
		</div>
	{:else if tab === 'preview'}
		<div class="md reading preview">{@html renderMarkdown(text) || '<p class="muted">Nothing yet.</p>'}</div>
	{:else}
		<ol class="history">
			{#each revisions as r (r.rev)}
				<li>
					<div class="tiny muted">Version {r.rev} · {relativeTime(r.createdAt)}</div>
					<div class="md small">{@html renderMarkdown(r.body)}</div>
				</li>
			{:else}
				<li class="muted small">Loading…</li>
			{/each}
		</ol>
	{/if}
	{#if error}<div class="error-box" role="alert"><Icon name="alert" size={18} />{error}</div>{/if}
	{#snippet footer()}
		{#if annotationId}<button type="button" class="btn btn-danger" onclick={remove}><Icon name="trash" size={18} />Delete</button>{/if}
		<span class="spacer"></span>
		<button type="button" class="btn" onclick={() => (open = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" disabled={saving || tab === 'history'} onclick={save}>{saving ? 'Saving…' : 'Save note'}</button>
	{/snippet}
</Modal>

<style>
	.quote {
		margin: 0;
		padding: 0.75rem 0.875rem;
		background: var(--surface-2);
		border-radius: var(--radius);
		font-size: 0.9375rem;
		color: var(--text);
		max-height: 8rem;
		overflow-y: auto;
	}
	.preview {
		min-height: 8rem;
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.75rem 0.875rem;
	}
	.history {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		max-height: 22rem;
		overflow-y: auto;
	}
	.history li {
		border-left: 3px solid var(--border-strong);
		padding-left: 0.75rem;
	}
</style>
