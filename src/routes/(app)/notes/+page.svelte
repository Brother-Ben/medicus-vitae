<script lang="ts">
	import { invalidate } from '$app/navigation';
	import { onMount } from 'svelte';
	import AnnotationEditor from '#lib/components/AnnotationEditor.svelte';
	import BookUploader from '#lib/components/BookUploader.svelte';
	import CodeTag from '#lib/components/CodeTag.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import Modal from '#lib/components/Modal.svelte';
	import { api } from '#lib/client/api.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import { relativeTime } from '#lib/dates.js';
	import { renderMarkdown } from '#lib/markdown.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Note = (typeof data.notes)[number];
	type File = (typeof data.files)[number];
	type Link = File['links'][number];

	// ---- filters (remembered on this device)
	let kind = $state<'all' | 'written' | 'pdf'>('all');
	let q = $state('');
	let book = $state(''); // '' all | 'none' | book id
	let chapter = $state('');
	let category = $state('');
	let sort = $state<'new' | 'old' | 'book'>('new');
	const FILTER_KEY = 'medicus-notes-filters';
	onMount(() => {
		try {
			const f = JSON.parse(localStorage.getItem(FILTER_KEY) ?? 'null') as { kind?: string; sort?: string } | null;
			if (f?.kind === 'all' || f?.kind === 'written' || f?.kind === 'pdf') kind = f.kind;
			if (f?.sort === 'new' || f?.sort === 'old' || f?.sort === 'book') sort = f.sort;
		} catch {
			// no saved filters
		}
	});
	$effect(() => {
		try {
			localStorage.setItem(FILTER_KEY, JSON.stringify({ kind, sort }));
		} catch {
			// storage unavailable
		}
	});

	// While a notes PDF is still being read, refresh every few seconds so it opens as soon as it's ready.
	const processing = $derived(data.files.some((f) => f.status === 'queued' || f.status === 'processing'));
	$effect(() => {
		if (!processing) return;
		const t = setInterval(() => void invalidate('app:notes'), 3000);
		return () => clearInterval(t);
	});

	const chapters = $derived(data.books.find((b) => b.id === book)?.sections ?? []);
	const chapterRow = $derived(chapters.find((s) => s.id === chapter) ?? null);
	$effect(() => {
		if (!chapters.some((s) => s.id === chapter)) chapter = '';
	});

	const needle = $derived(q.trim().toLowerCase());
	const overlaps = (a1: number, a2: number, b1: number, b2: number) => a1 <= b2 && b1 <= a2;

	function noteMatches(n: Note) {
		if (needle && !`${n.body} ${n.label} ${n.anchor?.exact ?? ''} ${n.documentTitle ?? ''} ${n.section ?? ''}`.toLowerCase().includes(needle)) return false;
		if (book === 'none' && n.documentId) return false;
		if (book && book !== 'none' && n.documentId !== book) return false;
		if (chapterRow && !(n.page && n.page >= chapterRow.pageStart && n.page <= chapterRow.pageEnd)) return false;
		if (category && !n.aamcCodes.includes(category)) return false;
		return true;
	}
	function linkMatches(l: Link) {
		if (book && book !== 'none' && l.bookDocumentId !== book) return false;
		if (chapterRow && !overlaps(l.bookPageFrom, l.bookPageTo, chapterRow.pageStart, chapterRow.pageEnd)) return false;
		if (category && !l.aamcCodes.includes(category)) return false;
		return true;
	}
	function fileMatches(f: File) {
		if (needle && !`${f.title} ${f.links.map((l) => `${l.label} ${l.bookTitle} ${l.section ?? ''}`).join(' ')}`.toLowerCase().includes(needle)) return false;
		if (book === 'none') return f.links.length === 0;
		if (book || chapterRow || category) return f.links.some(linkMatches);
		return true;
	}

	type Entry = { kind: 'note'; note: Note; at: number; bookTitle: string; page: number } | { kind: 'pdf'; file: File; at: number; bookTitle: string; page: number };
	const entries = $derived.by((): Entry[] => {
		const out: Entry[] = [];
		if (kind !== 'pdf') for (const n of data.notes.filter(noteMatches)) out.push({ kind: 'note', note: n, at: n.updatedAt, bookTitle: n.documentTitle ?? '', page: n.page ?? 0 });
		if (kind !== 'written')
			for (const f of data.files.filter(fileMatches)) {
				const first = f.links.find(linkMatches) ?? f.links[0];
				out.push({ kind: 'pdf', file: f, at: f.createdAt, bookTitle: first?.bookTitle ?? '', page: first?.bookPageFrom ?? 0 });
			}
		if (sort === 'new') out.sort((a, b) => b.at - a.at);
		else if (sort === 'old') out.sort((a, b) => a.at - b.at);
		else out.sort((a, b) => (a.bookTitle || '￿').localeCompare(b.bookTitle || '￿') || a.page - b.page);
		return out;
	});
	/** Book-order view: a heading for each book. */
	const groups = $derived.by(() => {
		if (sort !== 'book') return [{ title: '', items: entries }];
		const map = new Map<string, Entry[]>();
		for (const e of entries) {
			const k = e.bookTitle || 'Not linked to a book';
			(map.get(k) ?? map.set(k, []).get(k)!).push(e);
		}
		return [...map].map(([title, items]) => ({ title, items }));
	});
	const filtered = $derived(!!(needle || book || chapter || category));
	function clearFilters() {
		q = '';
		book = '';
		chapter = '';
		category = '';
	}

	// ---- written notes
	let open = $state(false);
	let editing = $state<{ id: string | null; body: string; quote: string }>({ id: null, body: '', quote: '' });

	// ---- PDFs
	let uploading = $state(false);
	let linkOpen = $state(false);
	let linkFor = $state<File | null>(null);
	let linkEditId = $state<string | null>(null);
	let lf = $state({ allPages: true, notesFrom: 1, notesTo: 1, bookId: '', sectionId: '', bookFrom: 1, bookTo: 1, label: '' });
	const lfBook = $derived(data.books.find((b) => b.id === lf.bookId) ?? null);
	$effect(() => {
		const s = lfBook?.sections.find((x) => x.id === lf.sectionId);
		if (s) {
			lf.bookFrom = s.pageStart;
			lf.bookTo = s.pageEnd;
		}
	});

	function openLink(file: File, link: Link | null = null) {
		linkFor = file;
		linkEditId = link?.id ?? null;
		lf = link
			? { allPages: link.notesPageFrom === null, notesFrom: link.notesPageFrom ?? 1, notesTo: link.notesPageTo ?? 1, bookId: link.bookDocumentId, sectionId: '', bookFrom: link.bookPageFrom, bookTo: link.bookPageTo, label: link.label }
			: { allPages: true, notesFrom: 1, notesTo: file.pageCount ?? 1, bookId: book && book !== 'none' ? book : (data.books[0]?.id ?? ''), sectionId: chapter, bookFrom: 1, bookTo: 1, label: '' };
		linkOpen = true;
	}

	async function saveLink() {
		if (!linkFor) return;
		const link = {
			notesDocumentId: linkFor.id,
			notesPageFrom: lf.allPages ? null : lf.notesFrom,
			notesPageTo: lf.allPages ? null : lf.notesTo,
			bookDocumentId: lf.bookId,
			bookPageFrom: lf.bookFrom,
			bookPageTo: lf.bookTo,
			label: lf.label
		};
		try {
			await api('/api/notes', { body: linkEditId ? { action: 'update-link', id: linkEditId, link } : { action: 'link', link } });
			toast(linkEditId ? 'Link updated' : 'Linked to the book');
			linkOpen = false;
			await invalidate('app:notes');
		} catch (err) {
			toastError(err);
		}
	}

	async function act(body: Record<string, unknown>, done: string) {
		try {
			await api('/api/notes', { body });
			toast(done);
			await invalidate('app:notes');
		} catch (err) {
			toastError(err);
		}
	}

	async function renameFile(f: File) {
		const title = prompt('Name for these notes', f.title);
		if (title && title.trim() && title !== f.title) await act({ action: 'rename', id: f.id, title }, 'Renamed');
	}

	async function deleteFile(f: File) {
		if (!confirm(`Delete “${f.title}”? Its links to book pages go too.`)) return;
		await act({ action: 'delete', id: f.id }, 'Notes PDF deleted');
	}

	const pagesLabel = (l: Link) => (l.bookPageFrom === l.bookPageTo ? `p. ${l.bookPageFrom}` : `pp. ${l.bookPageFrom}–${l.bookPageTo}`);
	const notesPages = (l: Link) => (l.notesPageFrom === null ? '' : l.notesPageFrom === l.notesPageTo ? ` (your page ${l.notesPageFrom})` : ` (your pages ${l.notesPageFrom}–${l.notesPageTo})`);
</script>

<svelte:head><title>Notes · Medicus Vitae</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div>
			<h1>Notes</h1>
			<p class="subtitle">Notes you wrote while reading, and PDFs of your own notes, each linked to the book pages it covers.</p>
		</div>
		<button type="button" class="btn btn-primary" aria-expanded={uploading} onclick={() => (uploading = !uploading)}><Icon name="upload" size={18} />Upload notes PDF</button>
	</header>

	{#if uploading}
		<div>
			<BookUploader
				role="notes"
				onuploaded={() => {
					void invalidate('app:notes');
				}}
			/>
		</div>
	{/if}

	<div class="filters card card-tight">
		<div class="row" style="justify-content: space-between">
			<div class="segmented" role="tablist" aria-label="Kind of note">
				<button type="button" role="tab" aria-selected={kind === 'all'} onclick={() => (kind = 'all')}>All · {data.notes.length + data.files.length}</button>
				<button type="button" role="tab" aria-selected={kind === 'written'} onclick={() => (kind = 'written')}>Written · {data.notes.length}</button>
				<button type="button" role="tab" aria-selected={kind === 'pdf'} onclick={() => (kind = 'pdf')}>PDFs · {data.files.length}</button>
			</div>
			<div class="segmented" role="radiogroup" aria-label="Sort">
				<button type="button" role="radio" aria-checked={sort === 'new'} onclick={() => (sort = 'new')}>Newest</button>
				<button type="button" role="radio" aria-checked={sort === 'old'} onclick={() => (sort = 'old')}>Oldest</button>
				<button type="button" role="radio" aria-checked={sort === 'book'} onclick={() => (sort = 'book')}>By book</button>
			</div>
		</div>
		<div class="filter-row">
			<label for="note-q" class="sr-only">Search notes</label>
			<input id="note-q" class="input" type="search" placeholder="Search notes" bind:value={q} />
			<label for="note-book" class="sr-only">Book</label>
			<select id="note-book" class="select" bind:value={book}>
				<option value="">All books</option>
				{#each data.books as b (b.id)}<option value={b.id}>{b.title}</option>{/each}
				<option value="none">Not linked to a book</option>
			</select>
			{#if chapters.length}
				<label for="note-ch" class="sr-only">Chapter</label>
				<select id="note-ch" class="select" bind:value={chapter}>
					<option value="">All chapters</option>
					{#each chapters as s (s.id)}<option value={s.id}>{'  '.repeat(s.level)}{s.title}</option>{/each}
				</select>
			{/if}
			{#if data.categories.length}
				<label for="note-cat" class="sr-only">AAMC category</label>
				<select id="note-cat" class="select" bind:value={category}>
					<option value="">All categories</option>
					{#each data.categories as c (c.code)}<option value={c.code}>{c.code} {c.name}</option>{/each}
				</select>
			{/if}
			{#if filtered}<button type="button" class="btn btn-sm btn-ghost" onclick={clearFilters}>Clear</button>{/if}
		</div>
	</div>

	{#if entries.length}
		{#each groups as g (g.title)}
			{#if g.title}<h2 class="group-title">{g.title}</h2>{/if}
			<div class="notes-grid">
				{#each g.items as e (e.kind === 'note' ? e.note.id : e.file.id)}
					{#if e.kind === 'note'}
						{@const n = e.note}
						<article class="card note-card">
							<div class="row" style="justify-content: space-between; gap: 0.5rem">
								<span class="tiny muted strong truncate" style="max-width: 70%">{n.label || n.documentTitle || 'Note on its own'}</span>
								<span class="tiny muted">{relativeTime(n.updatedAt)}{n.rev > 1 ? ` · v${n.rev}` : ''}</span>
							</div>
							{#if n.section || n.aamcCodes.length}
								<div class="row-tight">
									{#if n.section}<span class="topic-tag truncate" style="max-width: 100%">{n.section}</span>{/if}
									{#each n.aamcCodes.slice(0, 2) as c (c)}<CodeTag code={c} />{/each}
								</div>
							{/if}
							{#if n.anchor?.exact}<blockquote class="reading">{n.anchor.exact.length > 220 ? n.anchor.exact.slice(0, 219) + '…' : n.anchor.exact}</blockquote>{/if}
							<div class="md">{@html renderMarkdown(n.body)}</div>
							<div class="row-tight" style="margin-top: auto">
								{#if n.anchor}
									{#if n.anchor.available}
										<a class="source-chip" href="/library/{n.anchor.documentId}/read?anchor={n.anchor.id}"><Icon name="book" size={13} stroke={2} />Open in book</a>
									{:else}
										<span class="source-chip missing"><Icon name="alert" size={13} stroke={2} />Source missing</span>
									{/if}
								{/if}
								<button
									type="button"
									class="btn btn-sm btn-ghost"
									onclick={() => {
										editing = { id: n.id, body: n.body, quote: n.anchor?.exact ?? '' };
										open = true;
									}}>Edit</button
								>
							</div>
						</article>
					{:else}
						{@const f = e.file}
						<article class="card note-card pdf-card">
							<div class="row" style="justify-content: space-between; gap: 0.5rem; flex-wrap: nowrap">
								<span class="pdf-badge"><Icon name="note" size={16} />PDF</span>
								<span class="tiny muted">{f.pageCount ? `${f.pageCount} page${f.pageCount === 1 ? '' : 's'} · ` : ''}{relativeTime(f.createdAt)}</span>
							</div>
							<h3 class="pdf-title">{f.title}</h3>
							{#if f.status !== 'ready'}
								<div class="small muted">{f.status === 'failed' ? `Couldn’t read this file: ${f.error ?? 'unknown problem'}` : f.progressMessage || 'Getting it ready…'}</div>
							{/if}
							<div class="stack-sm">
								<span class="tiny muted strong">Linked to</span>
								{#if f.links.length}
									{#each f.links as l (l.id)}
										<div class="link-row" class:dim={(book || chapterRow || category) && !linkMatches(l)}>
											<a class="source-chip" href="/library/{l.bookDocumentId}/read?page={l.bookPageFrom}" title="Open the book at page {l.bookPageFrom}">
												<Icon name="book" size={13} stroke={2} />{l.bookTitle} · {pagesLabel(l)}
											</a>
											<span class="tiny muted">{l.label || l.section || ''}{notesPages(l)}</span>
											<span class="spacer"></span>
											<button type="button" class="icon-btn plain tiny-btn" aria-label="Change this link" onclick={() => openLink(f, l)}><Icon name="edit" size={14} /></button>
											<button type="button" class="icon-btn plain tiny-btn" aria-label="Remove this link" onclick={() => act({ action: 'unlink', id: l.id }, 'Link removed')}><Icon name="x" size={14} /></button>
										</div>
									{/each}
								{:else}
									<span class="small muted">Not linked yet. Link it to the book pages it covers and it shows up while you read them.</span>
								{/if}
							</div>
							<div class="row-tight" style="margin-top: auto">
								{#if f.status === 'ready'}<a class="btn btn-sm" href="/library/{f.id}/read"><Icon name="eye" size={15} />Open</a>{/if}
								<button type="button" class="btn btn-sm" disabled={!data.books.length} title={data.books.length ? '' : 'Import a book first'} onclick={() => openLink(f)}><Icon name="plus" size={15} />Link to book pages</button>
								<span class="spacer"></span>
								<button type="button" class="icon-btn plain tiny-btn" aria-label="Rename" onclick={() => renameFile(f)}><Icon name="edit" size={15} /></button>
								<button type="button" class="icon-btn plain tiny-btn" aria-label="Delete {f.title}" onclick={() => deleteFile(f)}><Icon name="trash" size={15} /></button>
							</div>
						</article>
					{/if}
				{/each}
			</div>
		{/each}
	{:else}
		<div class="card empty">
			<Icon name="note" size={32} />
			<h2>{filtered || kind !== 'all' ? 'No notes match' : 'No notes yet'}</h2>
			{#if filtered}
				<button type="button" class="btn btn-sm" onclick={clearFilters}>Clear filters</button>
			{:else}
				<p>While reading, select a passage and choose <strong>Note</strong>, or upload a PDF of your own notes.</p>
			{/if}
		</div>
	{/if}
</div>

<AnnotationEditor bind:open annotationId={editing.id} body={editing.body} quote={editing.quote} onsaved={() => invalidate('app:notes')} ondeleted={() => invalidate('app:notes')} />

<Modal bind:open={linkOpen} title={linkEditId ? 'Change link' : 'Link to book pages'}>
	{#if linkFor}
		<p class="small muted" style="margin-top: -0.25rem">Which pages of <strong style="color: var(--text)">{linkFor.title}</strong> go with which pages of a book. They’ll show up in the reader on those pages.</p>
		<div class="field">
			<span class="label" id="np-l">Pages of your notes</span>
			<div class="segmented" role="radiogroup" aria-labelledby="np-l">
				<button type="button" role="radio" aria-checked={lf.allPages} onclick={() => (lf.allPages = true)}>The whole file</button>
				<button type="button" role="radio" aria-checked={!lf.allPages} onclick={() => (lf.allPages = false)}>Some pages</button>
			</div>
			{#if !lf.allPages}
				<div class="row-tight">
					<label for="n-from" class="sr-only">From page</label>
					<input id="n-from" class="input mono" style="width: 5.5rem" type="number" min="1" max={linkFor.pageCount ?? undefined} bind:value={lf.notesFrom} />
					<span class="muted">to</span>
					<label for="n-to" class="sr-only">To page</label>
					<input id="n-to" class="input mono" style="width: 5.5rem" type="number" min="1" max={linkFor.pageCount ?? undefined} bind:value={lf.notesTo} />
				</div>
			{/if}
		</div>
		<div class="form-grid">
			<div class="field">
				<label for="l-book">Book</label>
				<select id="l-book" class="select" bind:value={lf.bookId} onchange={() => (lf.sectionId = '')}>
					{#each data.books as b (b.id)}<option value={b.id}>{b.title}</option>{/each}
				</select>
			</div>
			{#if lfBook?.sections.length}
				<div class="field">
					<label for="l-ch">Chapter</label>
					<select id="l-ch" class="select" bind:value={lf.sectionId}>
						<option value="">Pick pages yourself</option>
						{#each lfBook.sections as s (s.id)}<option value={s.id}>{'  '.repeat(s.level)}{s.title} (p. {s.pageStart}–{s.pageEnd})</option>{/each}
					</select>
				</div>
			{/if}
		</div>
		<div class="field">
			<span class="label">Book pages</span>
			<div class="row-tight">
				<label for="b-from" class="sr-only">From page</label>
				<input id="b-from" class="input mono" style="width: 5.5rem" type="number" min="1" max={lfBook?.pageCount} bind:value={lf.bookFrom} />
				<span class="muted">to</span>
				<label for="b-to" class="sr-only">To page</label>
				<input id="b-to" class="input mono" style="width: 5.5rem" type="number" min="1" max={lfBook?.pageCount} bind:value={lf.bookTo} />
				{#if lfBook}<span class="small muted">of {lfBook.pageCount}</span>{/if}
			</div>
		</div>
		<div class="field">
			<label for="l-label">Label <span class="muted" style="font-weight: 400">(optional)</span></label>
			<input id="l-label" class="input" placeholder="e.g. Enzyme kinetics summary" maxlength="120" bind:value={lf.label} />
		</div>
	{/if}
	{#snippet footer()}
		<button type="button" class="btn" onclick={() => (linkOpen = false)}>Cancel</button>
		<button type="button" class="btn btn-primary" disabled={!lf.bookId} onclick={saveLink}>{linkEditId ? 'Save' : 'Link'}</button>
	{/snippet}
</Modal>

<style>
	.filters {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.filter-row {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}
	.filter-row .input {
		flex: 1 1 14rem;
		min-height: 40px;
	}
	.filter-row .select {
		flex: 0 1 13rem;
		width: auto;
		min-height: 40px;
	}
	.group-title {
		font-size: 1rem;
		margin-bottom: -0.5rem;
		color: var(--text-2);
	}
	.notes-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(20rem, 1fr));
		gap: 1rem;
	}
	.note-card {
		display: flex;
		flex-direction: column;
		gap: 0.625rem;
	}
	.note-card blockquote {
		margin: 0;
		padding-left: 0.625rem;
		border-left: 3px solid var(--hl-yellow);
		color: var(--text-2);
		font-size: 0.875rem;
	}
	.pdf-badge {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		font-size: 0.75rem;
		font-weight: 700;
		color: var(--accent-text);
		background: var(--accent-soft);
		border-radius: 6px;
		padding: 0.25rem 0.5rem;
	}
	.pdf-title {
		font-size: 1rem;
		overflow-wrap: anywhere;
	}
	.link-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem;
	}
	.link-row.dim {
		opacity: 0.5;
	}
	.tiny-btn {
		width: 32px;
		height: 32px;
	}
</style>
