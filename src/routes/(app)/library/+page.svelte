<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { onDestroy } from 'svelte';
	import BookUploader from '#lib/components/BookUploader.svelte';
	import DeleteBookDialog from '#lib/components/DeleteBookDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { api } from '#lib/client/api.js';
	import { floatMenu } from '#lib/client/float-menu.js';
	import { toastError } from '#lib/client/toast.svelte.js';
	import { relativeTime } from '#lib/dates.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	const busy = $derived(data.books.some((b) => b.status === 'queued' || b.status === 'processing'));
	let timer: ReturnType<typeof setInterval> | null = null;
	$effect(() => {
		if (busy && !timer) timer = setInterval(() => invalidate('app:library'), 1500);
		if (!busy && timer) {
			clearInterval(timer);
			timer = null;
		}
	});
	onDestroy(() => timer && clearInterval(timer));

	async function retry(id: string) {
		try {
			await api(`/api/library/${id}`, { body: { action: 'retry' } });
			await invalidate('app:library');
		} catch (err) {
			toastError(err);
		}
	}

	function size(bytes: number) {
		return bytes > 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`;
	}

	let uploadOpen = $state(false);
	let menuFor = $state<string | null>(null);
	let deleting = $state<{ id: string; title: string } | null>(null);
	let deleteOpen = $state(false);
</script>

<svelte:window onclick={() => (menuFor = null)} />

<svelte:head><title>Library · Medicus Vitae</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div>
			<h1>Library</h1>
			<div class="subtitle">{data.books.length} book{data.books.length === 1 ? '' : 's'}</div>
		</div>
		<button type="button" class="btn btn-primary" onclick={() => (uploadOpen = !uploadOpen)} aria-expanded={uploadOpen}><Icon name="upload" size={16} />Import PDF</button>
	</header>

	{#if uploadOpen || !data.books.length}
		<BookUploader onuploaded={() => invalidate('app:library')} />
	{/if}

	{#if data.books.length}
		<div class="card card-flush">
			<div class="list">
				{#each data.books as b (b.id)}
					<div class="list-row book">
						<div class="cover" aria-hidden="true"><span>{b.title}</span></div>
						<div class="info">
							<a class="book-title" href="/library/{b.id}">{b.title}</a>
							{#if b.status === 'ready'}
								<div class="list-sub">
									{b.pageCount} pages · {size(b.fileSize)}{b.cards ? ` · ${b.cards} cards` : ''}{b.highlights ? ` · ${b.highlights} highlights` : ''}{b.lastOpenedAt ? ` · opened ${relativeTime(b.lastOpenedAt)}` : ''}
								</div>
								<div class="progress-line">
									<div class="bar" title="{b.done.pct}% done"><span style="width: {b.done.pct}%"></span></div>
									<span class="tiny muted nowrap">
										{b.done.sectionsTotal ? `${b.done.sectionsDone} of ${b.done.sectionsTotal} sections` : `${b.done.pagesDone} of ${b.pageCount} pages`} · {b.done.pct}%
									</span>
								</div>
								{#if b.linkedDecks.length}
									<div class="row-tight" style="margin-top: 0.25rem">
										{#each b.linkedDecks as d (d)}<span class="pill pill-sm"><Icon name="link" size={11} />{d.split('::').pop()}</span>{/each}
									</div>
								{/if}
								{#if b.notice}<div class="warning small" style="margin-top: 0.5rem"><Icon name="info" size={15} />{b.notice}</div>{/if}
								{#if b.fileMissing}<div class="error-box small" style="margin-top: 0.5rem"><Icon name="alert" size={15} />The original file is missing from the data folder.</div>{/if}
							{:else if b.status === 'failed'}
								<div class="error-box small" style="margin-top: 0.375rem"><Icon name="alert" size={15} />{b.error ?? 'Processing failed.'}</div>
							{:else}
								<div class="list-sub">{b.progressMessage || 'Waiting to start'}</div>
								<div class="bar" style="margin-top: 0.375rem; max-width: 20rem"><span style="width: {Math.round((b.progress ?? 0) * 100)}%"></span></div>
							{/if}
						</div>
						<div class="actions">
							{#if b.status === 'ready'}
								<a class="btn btn-sm" href="/library/{b.id}/read{b.lastPage ? `?page=${b.lastPage}` : ''}">{b.lastOpenedAt ? 'Resume' : 'Read'}</a>
							{:else if b.status === 'failed'}
								<button type="button" class="btn btn-sm" onclick={() => retry(b.id)}><Icon name="refresh" size={15} />Try again</button>
							{:else}
								<span class="pill pill-accent"><Icon name="refresh" size={12} />Processing</span>
							{/if}
							<div class="menu-wrap">
								<button
									type="button"
									class="icon-btn plain sm"
									aria-label="More for {b.title}"
									aria-haspopup="menu"
									aria-expanded={menuFor === b.id}
									onclick={(e) => {
										e.stopPropagation();
										menuFor = menuFor === b.id ? null : b.id;
									}}
								>
									<Icon name="more" size={18} />
								</button>
								{#if menuFor === b.id}
									<div class="menu" role="menu" use:floatMenu>
										<a role="menuitem" href="/library/{b.id}"><Icon name="list" size={15} />Chapters &amp; progress</a>
										<a role="menuitem" href="/library/{b.id}#decks"><Icon name="link" size={15} />Link an Anki deck</a>
										{#if b.cards}<a role="menuitem" href="/cards?doc={b.id}"><Icon name="cards" size={15} />Cards from this book</a>{/if}
										<hr />
										<button
											type="button"
											role="menuitem"
											class="danger"
											onclick={() => {
												deleting = { id: b.id, title: b.title };
												deleteOpen = true;
											}}><Icon name="trash" size={15} />Delete book…</button
										>
									</div>
								{/if}
							</div>
						</div>
					</div>
				{/each}
			</div>
		</div>
	{/if}
</div>

{#if deleting}
	<DeleteBookDialog bind:open={deleteOpen} bookId={deleting.id} title={deleting.title} ondeleted={() => invalidate('app:library')} />
{/if}

<style>
	.book {
		flex-wrap: nowrap;
		align-items: flex-start;
		padding-top: 0.875rem !important;
		padding-bottom: 0.875rem !important;
	}
	.cover {
		width: 44px;
		height: 58px;
		border-radius: 4px;
		background: var(--ink);
		color: var(--on-ink);
		flex: none;
		display: flex;
		align-items: flex-end;
		padding: 5px;
		font-size: 0.5625rem;
		font-weight: 700;
		line-height: 1.1;
		overflow: hidden;
		word-break: break-word;
	}
	.cover span {
		display: -webkit-box;
		-webkit-line-clamp: 4;
		line-clamp: 4;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.info {
		flex: 1 1 auto;
		min-width: 0;
	}
	.book-title {
		font-weight: 650;
		color: var(--text);
		text-decoration: none;
	}
	.book-title:hover {
		text-decoration: underline;
	}
	.progress-line {
		display: flex;
		align-items: center;
		gap: 0.625rem;
		margin-top: 0.4375rem;
		max-width: 28rem;
	}
	.progress-line .bar {
		flex: 1 1 auto;
	}
	.actions {
		display: flex;
		align-items: center;
		gap: 0.25rem;
		flex: none;
	}
	.menu-wrap {
		position: relative;
	}
	@media (max-width: 560px) {
		.book {
			flex-wrap: wrap;
		}
		.actions {
			width: 100%;
			justify-content: flex-end;
		}
	}
</style>
