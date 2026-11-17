<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import Icon from '#lib/components/Icon.svelte';
	import Modal from '#lib/components/Modal.svelte';
	import { api } from '#lib/client/api.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	// ---- Reset ("start over"): pick the parts, then confirm in a dialog.
	let picked = $state<Record<string, boolean>>({});
	let everything = $state(false);
	let confirmOpen = $state(false);
	let confirmText = $state('');
	let resetting = $state(false);
	let undoId = $state<string | null>(null);
	let undoing = $state(false);
	const chosen = $derived(data.resetParts.filter((p) => everything || picked[p.id]));

	function askReset() {
		confirmText = '';
		confirmOpen = true;
	}

	async function doReset() {
		resetting = true;
		try {
			const r = await api<{ snapshotId: string }>('/api/reset', {
				body: everything ? { everything: true, confirm: confirmText } : { parts: chosen.map((p) => p.id), confirm: confirmText }
			});
			confirmOpen = false;
			if (everything) {
				location.href = '/setup';
				return;
			}
			undoId = r.snapshotId || null;
			picked = {};
			toast('Reset done');
			await invalidateAll();
		} catch (err) {
			toastError(err);
		} finally {
			resetting = false;
		}
	}

	async function undo() {
		if (!undoId) return;
		undoing = true;
		try {
			await api('/api/sync', { body: { action: 'restore-snapshot', id: undoId } });
			undoId = null;
			toast('Everything is back the way it was');
			setTimeout(() => (location.href = '/'), 800);
		} catch (err) {
			toastError(err);
		} finally {
			undoing = false;
		}
	}

	let verifying = $state(false);
	let verify = $state<{ checked: number; events: number; mismatches: number } | null>(null);
	let restorePct = $state<number | null>(null);
	let restoreError = $state('');
	let restoreDone = $state(false);

	async function runVerify() {
		verifying = true;
		try {
			verify = await api('/api/verify', { body: {} });
		} catch (err) {
			toastError(err);
		} finally {
			verifying = false;
		}
	}

	function restore(e: Event) {
		e.preventDefault();
		const input = (e.currentTarget as HTMLFormElement).querySelector('input[type=file]') as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		if (!confirm('Replace everything in this installation with that export? Your current data is kept aside first.')) return;
		restoreError = '';
		restorePct = 0;
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', '/api/restore');
		xhr.setRequestHeader('content-type', 'application/zip');
		xhr.upload.onprogress = (ev) => {
			if (ev.lengthComputable) restorePct = Math.round((ev.loaded / ev.total) * 100);
		};
		xhr.onload = () => {
			if (xhr.status >= 200 && xhr.status < 300) {
				restoreDone = true;
				restorePct = null;
				setTimeout(() => (location.href = '/'), 1500);
			} else {
				restorePct = null;
				try {
					restoreError = JSON.parse(xhr.responseText).error;
				} catch {
					restoreError = 'Restore failed.';
				}
			}
		};
		xhr.onerror = () => {
			restorePct = null;
			restoreError = 'The upload failed.';
		};
		xhr.send(file);
	}
</script>

<svelte:head><title>Data · Settings · Medicus Vitae</title></svelte:head>

<section class="card stack">
	<h2>Export</h2>
	<p class="small muted">
		Everything in one zip: the database (for restoring), your original books, readable JSON copies of your data, your reading notes as Markdown, and a cards CSV.
		Restoring it on a fresh installation brings everything back.
	</p>
	<div class="row">
		<a class="btn btn-primary" href="/api/export" download><Icon name="download" size={18} />Export everything</a>
		<a class="btn" href="/api/export?cards=csv" download><Icon name="download" size={18} />Cards CSV only</a>
	</div>
	<p class="hint">The cards CSV imports into Anki with File › Import (comma-separated, HTML on). AAMC categories become tags like AAMC::1A.</p>
</section>

<section class="card stack">
	<h2>Restore from an export</h2>
	{#if data.role !== 'primary'}
		<p class="small muted">Make this device primary first (Backups &amp; sync).</p>
	{:else if restoreDone}
		<div class="notice"><Icon name="check" size={18} />Restored. Opening Today…</div>
	{:else}
		<p class="small muted">Replaces all data in this installation with the export. What you have now is kept aside in the data folder and in a snapshot.</p>
		<form class="row" onsubmit={restore}>
			<label for="restore-file" class="sr-only">Export file</label>
			<input id="restore-file" type="file" accept=".zip,application/zip" class="input" style="max-width: 24rem; padding-top: 0.6rem" required />
			<button class="btn" disabled={restorePct !== null}>{restorePct !== null ? `Uploading ${restorePct}%…` : 'Restore'}</button>
		</form>
		{#if restoreError}<div class="error-box"><Icon name="alert" size={18} />{restoreError}</div>{/if}
	{/if}
</section>

<section class="card stack">
	<h2>Check review history</h2>
	<p class="small muted">Replays every stored review from the start and confirms each card’s schedule comes out identical.</p>
	<div><button type="button" class="btn" disabled={verifying} onclick={runVerify}>{verifying ? 'Checking…' : 'Run check'}</button></div>
	{#if verify}
		{#if verify.mismatches === 0}
			<div class="notice"><Icon name="check" size={18} />All {verify.checked} cards match their {verify.events} reviews.</div>
		{:else}
			<div class="error-box"><Icon name="alert" size={18} />{verify.mismatches} of {verify.checked} cards don’t match their review history.</div>
		{/if}
	{/if}
</section>

<section class="card stack danger-zone" aria-labelledby="reset-h">
	<div>
		<h2 id="reset-h">Start over</h2>
		<p class="small muted" style="margin-top: 0.25rem">Clear out the parts you pick and keep the rest. A safety copy is saved first, so you can undo it.</p>
	</div>
	{#if undoId}
		<div class="notice" role="status">
			<Icon name="check" size={18} />
			<span style="flex: 1 1 auto">Reset done. Changed your mind? Undo puts everything back as it was a moment ago.</span>
			<button type="button" class="btn btn-sm" disabled={undoing} onclick={undo}>{undoing ? 'Undoing…' : 'Undo reset'}</button>
		</div>
	{/if}
	{#if data.role !== 'primary'}
		<p class="small muted">Make this device primary first (Backups &amp; sync).</p>
	{:else}
		<div class="reset-list" class:off={everything}>
			{#each data.resetParts as p (p.id)}
				<label class="reset-item">
					<input type="checkbox" disabled={everything} checked={everything || !!picked[p.id]} onchange={(e) => (picked = { ...picked, [p.id]: (e.currentTarget as HTMLInputElement).checked })} />
					<span>
						<span class="strong">{p.name}</span> <span class="tiny muted">· {p.size}</span>
						<span class="small muted reset-detail">{p.detail}</span>
					</span>
				</label>
			{/each}
		</div>
		<label class="reset-item everything">
			<input type="checkbox" checked={everything} onchange={(e) => (everything = (e.currentTarget as HTMLInputElement).checked)} />
			<span>
				<span class="strong">Everything, as if just installed</span>
				<span class="small muted reset-detail">All of the above plus your password, two-step sign-in and AI connections. You’ll set up Medicus Vitae again.</span>
			</span>
		</label>
		<div>
			<button type="button" class="btn btn-danger" disabled={!chosen.length} onclick={askReset}><Icon name="trash" size={18} />Reset{chosen.length && !everything ? ` ${chosen.length} part${chosen.length === 1 ? '' : 's'}` : everything ? ' everything' : ''}…</button>
		</div>
	{/if}
</section>

<Modal bind:open={confirmOpen} title="Are you sure?">
	<p>This permanently clears:</p>
	<ul class="confirm-list">
		{#each chosen as p (p.id)}<li><strong>{p.name}</strong> <span class="muted">({p.size})</span></li>{/each}
		{#if everything}<li><strong>Your password, sign-in and AI connections</strong></li>{/if}
	</ul>
	<p class="small muted">
		A safety copy is saved first.
		{everything
			? 'To get it back after setting up again, open Settings › Backups & sync and restore the “Before reset” snapshot.'
			: 'Use “Undo reset” right after, or restore the “Before reset” snapshot in Backups & sync later.'}
	</p>
	<div class="field">
		<label for="confirm-reset">Type <span class="mono strong">RESET</span> to confirm</label>
		<input id="confirm-reset" class="input mono" autocomplete="off" bind:value={confirmText} />
	</div>
	{#snippet footer()}
		<button type="button" class="btn" onclick={() => (confirmOpen = false)}>Keep my data</button>
		<button type="button" class="btn btn-danger-solid" disabled={resetting || confirmText.trim().toUpperCase() !== 'RESET'} onclick={doReset}>
			<Icon name="trash" size={18} />{resetting ? 'Resetting…' : 'Yes, reset'}
		</button>
	{/snippet}
</Modal>

<section class="card stack-sm">
	<h2>About</h2>
	<div class="small stack-sm">
		<div class="row" style="justify-content: space-between"><span class="muted">Version</span><span class="mono">{data.version}</span></div>
		<div class="row" style="justify-content: space-between"><span class="muted">Data folder</span><span class="mono" style="overflow-wrap: anywhere">{data.dataDir}</span></div>
		<div class="row" style="justify-content: space-between"><span class="muted">Scheduler</span><span>{data.scheduler}</span></div>
		<div class="row" style="justify-content: space-between">
			<span class="muted">Stored</span>
			<span>{data.counts.books} books · {data.counts.cards} cards · {data.counts.reviews} reviews · {data.counts.notes} notes · {data.counts.highlights} highlights · {data.counts.mistakes} mistakes · {data.counts.fullLengths} full-lengths</span>
		</div>
	</div>
</section>

<style>
	.danger-zone {
		border-color: var(--weak-border);
	}
	.reset-list {
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.reset-list.off {
		opacity: 0.6;
	}
	.reset-item {
		display: flex;
		align-items: flex-start;
		gap: 0.75rem;
		padding: 0.5rem 0.25rem;
		cursor: pointer;
	}
	.reset-item input {
		width: 1.25rem;
		height: 1.25rem;
		margin-top: 0.125rem;
		accent-color: var(--weak);
		flex: none;
	}
	.reset-detail {
		display: block;
	}
	.reset-item.everything {
		border-top: 1px solid var(--border);
		padding-top: 0.875rem;
	}
	.confirm-list {
		margin: 0;
		padding-left: 1.25rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
</style>
