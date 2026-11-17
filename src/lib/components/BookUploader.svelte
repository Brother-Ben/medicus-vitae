<script lang="ts">
	import Icon from './Icon.svelte';

	let {
		onuploaded,
		compact = false,
		role = 'book'
	}: { onuploaded?: (ids: string[]) => void; compact?: boolean; /** notes: PDFs of your own notes (Notes page). */ role?: 'book' | 'notes' } = $props();
	const notes = $derived(role === 'notes');

	interface Item {
		name: string;
		pct: number;
		status: 'uploading' | 'done' | 'duplicate' | 'error';
		message?: string;
	}

	let items = $state<Item[]>([]);
	let dragging = $state(false);
	let input: HTMLInputElement | undefined = $state();

	function upload(file: File, item: Item): Promise<string | null> {
		return new Promise((resolve) => {
			const xhr = new XMLHttpRequest();
			xhr.open('PUT', `/api/library/upload?name=${encodeURIComponent(file.name)}${notes ? '&role=notes' : ''}`);
			xhr.setRequestHeader('content-type', 'application/pdf');
			xhr.upload.onprogress = (e) => {
				if (e.lengthComputable) item.pct = Math.round((e.loaded / e.total) * 100);
			};
			xhr.onload = () => {
				let body: { id?: string; duplicate?: boolean; error?: string } = {};
				try {
					body = JSON.parse(xhr.responseText);
				} catch {
					body = { error: xhr.responseText };
				}
				if (xhr.status >= 200 && xhr.status < 300 && body.id) {
					item.pct = 100;
					item.status = body.duplicate ? 'duplicate' : 'done';
					item.message = body.duplicate ? (notes ? 'You already uploaded this file' : 'Already in your library') : 'Uploaded. Processing has started.';
					resolve(body.id);
				} else {
					item.status = 'error';
					item.message = body.error || `Upload failed (${xhr.status})`;
					resolve(null);
				}
			};
			xhr.onerror = () => {
				item.status = 'error';
				item.message = 'Upload failed. Is Medicus Vitae still running?';
				resolve(null);
			};
			xhr.send(file);
		});
	}

	async function handle(files: FileList | File[]) {
		const list = [...files];
		const ids: string[] = [];
		for (const file of list) {
			items.push({ name: file.name, pct: 0, status: 'uploading' });
			const item = items[items.length - 1];
			const id = await upload(file, item);
			if (id) ids.push(id);
		}
		if (ids.length) onuploaded?.(ids);
		if (input) input.value = '';
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		if (e.dataTransfer?.files.length) void handle(e.dataTransfer.files);
	}
</script>

<div
	class="drop"
	class:dragging
	class:compact
	role="group"
	aria-label={notes ? 'Upload notes PDFs' : 'Import PDF books'}
	ondragover={(e) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragleave={() => (dragging = false)}
	ondrop={onDrop}
>
	<Icon name="upload" size={compact ? 18 : 22} />
	<div>
		<div class="strong">{notes ? 'Upload your notes as PDFs' : 'Import a PDF book'}</div>
		<div class="small muted">
			{notes
				? 'Drop files here or choose them: notes from GoodNotes, Notability, OneNote or scans. Then link them to the book pages they cover.'
				: 'Drop files here or choose them. Text-based PDFs work best; scanned books need OCR, which comes later.'}
		</div>
	</div>
	<label class="btn btn-primary">
		Choose PDFs
		<input bind:this={input} type="file" accept="application/pdf,.pdf" multiple class="sr-only" onchange={(e) => {
			const files = (e.currentTarget as HTMLInputElement).files;
			if (files?.length) void handle(files);
		}} />
	</label>
</div>

{#if items.length}
	<ul class="uploads">
		{#each items as item, i (i)}
			<li>
				<div class="row" style="justify-content: space-between">
					<span class="truncate strong" style="max-width: 70%">{item.name}</span>
					<span class="small" class:muted={item.status !== 'error'} style:color={item.status === 'error' ? 'var(--weak-text)' : undefined}>
						{item.status === 'uploading' ? `${item.pct}%` : item.message}
					</span>
				</div>
				{#if item.status === 'uploading'}<div class="bar" style="margin-top: 6px"><span style="width: {item.pct}%"></span></div>{/if}
			</li>
		{/each}
	</ul>
{/if}

<style>
	.drop {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.875rem;
		padding: 1.125rem 1.25rem;
		border: 1px dashed var(--border-strong);
		border-radius: var(--radius-lg);
		background: var(--surface);
		color: var(--text-2);
	}
	.drop > div {
		flex: 1 1 16rem;
	}
	.drop.compact {
		padding: 1rem;
	}
	.drop.dragging {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.uploads {
		list-style: none;
		padding: 0;
		margin: 0.75rem 0 0;
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}
	.uploads li {
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: var(--radius);
		padding: 0.625rem 0.875rem;
	}
</style>
