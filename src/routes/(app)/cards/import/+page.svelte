<script lang="ts">
	import { goto } from '$app/navigation';
	import Icon from '#lib/components/Icon.svelte';
	import { relativeTime } from '#lib/dates.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let dragging = $state(false);
	let uploading = $state<{ name: string; pct: number } | null>(null);
	let error = $state('');
	let input: HTMLInputElement | undefined = $state();

	const STATUS: Record<string, string> = {
		analyzing: 'Reading…',
		ready: 'Waiting for you',
		importing: 'Importing…',
		done: 'Imported',
		failed: 'Failed',
		cancelled: 'Cancelled'
	};

	function upload(file: File) {
		error = '';
		if (!/\.(apkg|colpkg)$/i.test(file.name)) {
			error = 'Choose an Anki package: a file ending in .apkg (or .colpkg for a whole collection).';
			return;
		}
		uploading = { name: file.name, pct: 0 };
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', `/api/anki/upload?name=${encodeURIComponent(file.name)}`);
		xhr.setRequestHeader('content-type', 'application/octet-stream');
		xhr.upload.onprogress = (e) => {
			if (e.lengthComputable && uploading) uploading.pct = Math.round((e.loaded / e.total) * 100);
		};
		xhr.onload = () => {
			let body: { id?: string; error?: string } = {};
			try {
				body = JSON.parse(xhr.responseText);
			} catch {
				body = { error: xhr.responseText };
			}
			uploading = null;
			if (xhr.status >= 200 && xhr.status < 300 && body.id) void goto(`/cards/import/${body.id}`);
			else error = body.error || `Upload failed (${xhr.status})`;
			if (input) input.value = '';
		};
		xhr.onerror = () => {
			uploading = null;
			error = 'Upload failed. Is Medicus Vitae still running?';
		};
		xhr.send(file);
	}

	function onDrop(e: DragEvent) {
		e.preventDefault();
		dragging = false;
		const f = e.dataTransfer?.files[0];
		if (f) upload(f);
	}
</script>

<svelte:head><title>Import from Anki · Medicus Vitae</title></svelte:head>

<div class="page narrow">
	<header class="page-header">
		<div>
			<a class="small muted back" href="/cards"><Icon name="arrow-left" size={14} />Flashcards</a>
			<h1>Import from Anki</h1>
			<p class="subtitle">Bring in a deck you use in Anki, or a shared MCAT deck, with its images, sounds and review history.</p>
		</div>
	</header>

	<div
		class="drop card"
		class:dragging
		role="group"
		aria-label="Choose an Anki package"
		ondragover={(e) => {
			e.preventDefault();
			dragging = true;
		}}
		ondragleave={() => (dragging = false)}
		ondrop={onDrop}
	>
		<Icon name="upload" size={28} />
		<div>
			<div class="strong">Choose an .apkg file</div>
			<div class="small muted">
				In Anki: <strong>File › Export</strong>, choose <strong>Anki Deck Package</strong>, and tick <strong>Include scheduling information</strong> and <strong>Include media</strong> to bring your progress and images. Nothing is added until you’ve seen the report and said go.
			</div>
		</div>
		<label class="btn btn-primary">
			Choose file
			<input bind:this={input} type="file" accept=".apkg,.colpkg" class="sr-only" onchange={(e) => {
				const f = (e.currentTarget as HTMLInputElement).files?.[0];
				if (f) upload(f);
			}} />
		</label>
	</div>

	{#if uploading}
		<div class="card card-tight">
			<div class="row" style="justify-content: space-between">
				<span class="truncate strong">{uploading.name}</span><span class="small muted">{uploading.pct}%</span>
			</div>
			<div class="bar" style="margin-top: 6px"><span style="width: {uploading.pct}%"></span></div>
		</div>
	{/if}
	{#if error}<div class="error-box" role="alert"><Icon name="alert" size={18} />{error}</div>{/if}

	{#if data.imports.length}
		<section>
			<h2 style="font-size: 1rem; margin-bottom: 0.5rem">Earlier imports</h2>
			<div class="card" style="padding: 0.25rem 1.25rem">
				<div class="list">
					{#each data.imports as imp (imp.id)}
						<a class="list-row plain-link" href="/cards/import/{imp.id}">
							<div style="flex: 1 1 16rem; min-width: 0">
								<div class="list-title truncate">{imp.fileName}</div>
								<div class="list-sub">
									{STATUS[imp.status] ?? imp.status} · {relativeTime(imp.finishedAt ?? imp.createdAt)}
									{#if imp.notesAdded !== null}· {imp.notesAdded} new, {imp.notesUpdated ?? 0} updated{/if}
								</div>
							</div>
							<Icon name="chevron-right" size={16} />
						</a>
					{/each}
				</div>
			</div>
		</section>
	{/if}

	<p class="small muted">
		Imported: basic, reversed and cloze notes (including your own note types and their scripts), image occlusion cards, tags, images, sounds, math,
		review history, and each deck’s order of new cards. Not yet: editing image occlusion masks, and deck options other than desired retention. The report
		lists anything affected before you import. Importing a deck again updates it without making duplicates.
	</p>
</div>

<style>
	.narrow {
		max-width: 52rem;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: 0.25rem;
		margin-bottom: 0.25rem;
		color: var(--text-3);
		text-decoration: none;
	}
	.drop {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 1rem;
		padding: 1.5rem;
		border: 2px dashed var(--border-strong);
	}
	.drop > div {
		flex: 1 1 18rem;
	}
	.drop.dragging {
		border-color: var(--accent);
		background: var(--accent-soft);
	}
	.plain-link {
		color: inherit;
		text-decoration: none;
	}
</style>
