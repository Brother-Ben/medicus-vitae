<script lang="ts">
	import { enhance } from '$app/forms';
	import { onMount } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();

	let mode = $state<'new' | 'restore' | 'standby'>('new');
	let timeZone = $state('UTC');
	let busy = $state(false);
	let uploadPct = $state<number | null>(null);
	let restoreError = $state('');

	$effect(() => {
		if (form?.mode) mode = form.mode as typeof mode;
	});

	onMount(() => {
		try {
			timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
		} catch {
			timeZone = 'UTC';
		}
	});

	function restore(e: Event) {
		e.preventDefault();
		const input = (e.currentTarget as HTMLFormElement).querySelector('input[type=file]') as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) {
			restoreError = 'Choose the export .zip file first.';
			return;
		}
		restoreError = '';
		busy = true;
		uploadPct = 0;
		const xhr = new XMLHttpRequest();
		xhr.open('PUT', '/api/setup/restore');
		xhr.setRequestHeader('content-type', 'application/zip');
		xhr.upload.onprogress = (ev) => {
			if (ev.lengthComputable) uploadPct = Math.round((ev.loaded / ev.total) * 100);
		};
		xhr.onload = () => {
			busy = false;
			if (xhr.status >= 200 && xhr.status < 300) {
				location.href = '/login?restored=1';
			} else {
				uploadPct = null;
				try {
					restoreError = JSON.parse(xhr.responseText).error;
				} catch {
					restoreError = xhr.responseText || 'Restore failed.';
				}
			}
		};
		xhr.onerror = () => {
			busy = false;
			uploadPct = null;
			restoreError = 'The upload failed. Is Medicus Vitae still running?';
		};
		xhr.send(file);
	}
</script>

<svelte:head><title>Set up Medicus Vitae</title></svelte:head>

<div class="card auth-card wide stack">
	<div>
		<h1 style="font-size: 1.625rem">Welcome</h1>
		<p class="muted" style="margin-top: 0.375rem">
			Medicus Vitae keeps everything on this computer. Set a password so nothing can be viewed without signing in.
		</p>
	</div>

	<div class="segmented" role="tablist" aria-label="How to start">
		<button type="button" role="tab" aria-selected={mode === 'new'} onclick={() => (mode = 'new')}>New account</button>
		<button type="button" role="tab" aria-selected={mode === 'restore'} onclick={() => (mode = 'restore')}>Restore from an export</button>
		<button type="button" role="tab" aria-selected={mode === 'standby'} onclick={() => (mode = 'standby')}>Standby for another device</button>
	</div>

	{#if mode === 'new'}
		<form method="POST" action="?/create" class="stack" use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				busy = false;
				await update({ reset: false });
			};
		}}>
			<div class="field">
				<label for="displayName">Your first name <span class="muted">(optional)</span></label>
				<input id="displayName" name="displayName" class="input" autocomplete="given-name" value={form?.displayName ?? ''} />
				<span class="hint">Used for the greeting on Today.</span>
			</div>
			<div class="field">
				<label for="password">Password</label>
				<input id="password" name="password" type="password" class="input" autocomplete="new-password" required minlength="8" />
				<span class="hint">At least 8 characters.</span>
			</div>
			<div class="field">
				<label for="confirm">Confirm password</label>
				<input id="confirm" name="confirm" type="password" class="input" autocomplete="new-password" required minlength="8" />
			</div>
			<input type="hidden" name="timeZone" value={timeZone} />
			{#if form?.error && form.mode === 'new'}<div class="error-box" role="alert"><Icon name="alert" size={18} />{form.error}</div>{/if}
			<button class="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Creating…' : 'Create account'}</button>
		</form>
	{:else if mode === 'restore'}
		<form class="stack" onsubmit={restore}>
			<p class="muted small">
				Choose a <strong>medicus-vitae-export-….zip</strong> (or an older <strong>cortex-export-….zip</strong>) made with Settings › Data › Export everything. Your books, cards, reviews,
				notes and history come back exactly as they were. Sign in afterwards with the password from that installation.
			</p>
			<div class="field">
				<label for="exportFile">Export file</label>
				<input id="exportFile" type="file" accept=".zip,application/zip" class="input" style="padding-top: 0.6rem" />
			</div>
			{#if uploadPct !== null}
				<div>
					<div class="small muted">{uploadPct < 100 ? `Uploading… ${uploadPct}%` : 'Restoring…'}</div>
					<div class="bar" style="margin-top: 0.375rem"><span style="width: {uploadPct}%"></span></div>
				</div>
			{/if}
			{#if restoreError}<div class="error-box" role="alert"><Icon name="alert" size={18} />{restoreError}</div>{/if}
			<button class="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Restoring…' : 'Restore'}</button>
		</form>
	{:else}
		<form method="POST" action="?/standby" class="stack" use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				busy = false;
				await update({ reset: false });
			};
		}}>
			<p class="muted small">
				Use this on the Windows PC that should keep a copy of your server’s data. It pulls the newest snapshot and stays read-only until
				you choose <strong>Make this device primary</strong>. On the other device, find its address and pairing key in Settings › Backups &amp; sync.
			</p>
			<div class="field">
				<label for="peerUrl">Other device’s address</label>
				<input id="peerUrl" name="peerUrl" class="input" placeholder="https://my-server.tailnet.ts.net" value={form?.peerUrl ?? ''} required />
			</div>
			<div class="field">
				<label for="peerKey">Pairing key</label>
				<input id="peerKey" name="peerKey" class="input mono" autocomplete="off" required />
			</div>
			{#if form?.error && form.mode === 'standby'}<div class="error-box" role="alert"><Icon name="alert" size={18} />{form.error}</div>{/if}
			<button class="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Copying data…' : 'Connect and copy'}</button>
		</form>
	{/if}
</div>
