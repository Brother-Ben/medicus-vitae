<script lang="ts">
	import { invalidate, invalidateAll } from '$app/navigation';
	import Icon from '#lib/components/Icon.svelte';
	import { api } from '#lib/client/api.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import { durationLabel, relativeTime } from '#lib/dates.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let url = $state('');
	let key = $state('');
	let busy = $state(false);
	let showKey = $state(false);
	let confirmPromote = $state<{ message: string; heldAgeMs: number | null } | null>(null);

	const roleLabel = { primary: 'Primary', standby: 'Standby', handing_off: 'Handing off' } as const;
	const typeLabel: Record<string, string> = {
		hourly: 'Hourly',
		daily: 'Daily',
		manual: 'Manual',
		'pre-upgrade': 'Before upgrade',
		'pre-restore': 'Before restore',
		'pre-reset': 'Before reset',
		'pre-delete': 'Before deleting',
		'pre-promotion': 'After switching',
		handoff: 'Handoff',
		peer: 'From other device'
	};

	async function sync(body: Record<string, unknown>) {
		busy = true;
		try {
			const r = await api<{ ok?: boolean; message?: string; needsConfirm?: boolean; heldAgeMs?: number | null }>('/api/sync', { body });
			if (r.needsConfirm) {
				confirmPromote = { message: r.message ?? '', heldAgeMs: r.heldAgeMs ?? null };
				return;
			}
			confirmPromote = null;
			if (r.message) toast(r.message);
			await invalidateAll();
		} catch (err) {
			toastError(err);
		} finally {
			busy = false;
		}
	}

	async function copyKey() {
		try {
			await navigator.clipboard.writeText(data.pairingKey);
			toast('Pairing key copied');
		} catch {
			showKey = true;
		}
	}

	function size(b: number) {
		return b > 1_000_000 ? `${(b / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1000))} KB`;
	}

	const held = $derived(data.state.held);
</script>

<svelte:head><title>Backups & sync · Settings · Medicus Vitae</title></svelte:head>

{#if data.state.conflict}
	{@const c = data.state.conflict}
	<section class="card stack conflict">
		<h2><Icon name="alert" size={20} /> Both devices took changes</h2>
		<p>{c.reason}</p>
		<p class="small">
			This device ({data.device.hostName}) had about {c.localChanges} change{c.localChanges === 1 ? '' : 's'} that {c.otherHostName} never received.
			Its copy is kept at <span class="mono">{c.keptAsidePath}</span>. This device now shows {c.otherHostName}’s copy.
		</p>
		<p class="small">This version can’t merge the two. Choose which copy to keep; the other stays on disk.</p>
		<div class="row">
			<button type="button" class="btn" disabled={busy} onclick={() => sync({ action: 'resolve', choice: 'keep-other' })}>Keep {c.otherHostName}’s copy</button>
			<button type="button" class="btn btn-primary" disabled={busy} onclick={() => sync({ action: 'resolve', choice: 'keep-mine' })}>Keep this device’s copy</button>
		</div>
	</section>
{/if}

<section class="card stack">
	<div class="card-header">
		<div>
			<h2>This device</h2>
			<div class="card-sub">{data.device.hostName} · generation {data.device.generation}</div>
		</div>
		<span class="pill {data.device.role === 'primary' ? 'pill-accent' : 'pill-warn'}">{roleLabel[data.device.role]}</span>
	</div>
	{#if data.device.role === 'primary'}
		<p class="small muted">
			This device takes changes. It makes a snapshot every hour when something changed (kept 48 hours) and every day (kept 30 days).
			{#if data.peer}Your other device pulls the newest one whenever it’s on.{/if}
		</p>
	{:else if data.device.role === 'handing_off'}
		<div class="warning"><Icon name="info" size={18} />Handing over to the other device. This device is read-only until that finishes.</div>
		<div><button type="button" class="btn" disabled={busy} onclick={() => sync({ action: 'cancel-handoff' })}>Cancel and stay primary</button></div>
	{:else}
		<p class="small muted">
			This device is a standby: a read-only copy that pulls the primary’s newest snapshot every few minutes. If the primary is down, make this one primary and keep studying here.
		</p>
		<div class="held">
			<div class="stat-label">Newest snapshot held</div>
			<div class="stat-value" style="font-size: 1.375rem">{held ? relativeTime(held.createdAt) : 'None yet'}</div>
			{#if held}<div class="stat-sub">{new Date(held.createdAt).toLocaleString()} · from {held.sourceHostName} · pulled {relativeTime(held.appliedAt)}</div>{/if}
		</div>
		{#if confirmPromote}
			<div class="warning stack-sm" style="display: block">
				<p class="strong">{confirmPromote.message}</p>
				<p class="small" style="margin-top: 0.375rem">
					Your newest copy is {confirmPromote.heldAgeMs !== null ? `${durationLabel(confirmPromote.heldAgeMs / 1000, 'long')} old` : 'unknown age'}. Anything done on the other device after that won’t be here.
				</p>
				<div class="row" style="margin-top: 0.75rem">
					<button type="button" class="btn btn-primary" disabled={busy} onclick={() => sync({ action: 'promote', force: true })}>It’s stopped. Make this device primary</button>
					<button type="button" class="btn" onclick={() => (confirmPromote = null)}>Cancel</button>
				</div>
			</div>
		{:else}
			<div><button type="button" class="btn btn-primary" disabled={busy} onclick={() => sync({ action: 'promote' })}><Icon name="sync" size={18} />Make this device primary</button></div>
		{/if}
	{/if}
	{#if data.state.keptAside}
		<p class="tiny muted">Earlier copy kept aside {relativeTime(data.state.keptAside.at)}: <span class="mono">{data.state.keptAside.path}</span> ({data.state.keptAside.reason})</p>
	{/if}
</section>

<section class="card stack">
	<h2>Other device</h2>
	{#if data.peer}
		<div class="stack-sm small">
			<div class="row" style="justify-content: space-between"><span class="muted">Address</span><span class="mono">{data.peer.url}</span></div>
			<div class="row" style="justify-content: space-between">
				<span class="muted">Status</span>
				<span>{data.state.peerHostName ? `${data.state.peerHostName} · ${data.state.peerRole ? roleLabel[data.state.peerRole] : '?'} · generation ${data.state.peerGeneration}` : 'Not reached yet'}</span>
			</div>
			<div class="row" style="justify-content: space-between"><span class="muted">Last contact</span><span>{data.state.lastContactAt ? relativeTime(data.state.lastContactAt) : 'Never'}</span></div>
			{#if data.state.lastPullAt}<div class="row" style="justify-content: space-between"><span class="muted">Last pull</span><span>{relativeTime(data.state.lastPullAt)}</span></div>{/if}
		</div>
		{#if data.state.lastError}<div class="warning small"><Icon name="alert" size={16} />{data.state.lastError}</div>{/if}
		<div class="row">
			<button type="button" class="btn" disabled={busy} onclick={() => sync({ action: 'check' })}>
				<Icon name="refresh" size={18} />{data.device.role === 'standby' ? 'Pull now' : 'Check now'}
			</button>
			{#if data.device.role === 'primary'}<button type="button" class="btn btn-ghost" disabled={busy} onclick={() => sync({ action: 'remove-peer' })}>Remove</button>{/if}
		</div>
	{:else}
		<p class="small muted">
			Pair this device with your other one (for example a home server and this computer). Enter the <strong>other</strong> device’s address and the pairing key shown on the device that has your data.
		</p>
		<form
			class="stack"
			onsubmit={(e) => {
				e.preventDefault();
				void sync({ action: 'configure', url, key });
			}}
		>
			<div class="form-grid">
				<div class="field"><label for="peer-url">Other device’s address</label><input id="peer-url" class="input" bind:value={url} placeholder="https://my-server.tailnet.ts.net" required /></div>
				<div class="field"><label for="peer-key">Pairing key</label><input id="peer-key" class="input mono" bind:value={key} autocomplete="off" required /></div>
			</div>
			<div><button class="btn btn-primary" disabled={busy}>Connect</button></div>
		</form>
	{/if}
	<div class="stack-sm" style="margin-top: 0.5rem">
		<div class="label">This installation’s pairing key</div>
		<div class="row-tight">
			<input class="input mono" style="max-width: 26rem" readonly type={showKey ? 'text' : 'password'} value={data.pairingKey} aria-label="Pairing key" />
			<button type="button" class="btn btn-sm" onclick={() => (showKey = !showKey)}>{showKey ? 'Hide' : 'Show'}</button>
			<button type="button" class="btn btn-sm" onclick={copyKey}>Copy</button>
		</div>
		<p class="hint">
			Both devices use the same key once paired. This device’s address for the other one: over Tailscale, run <span class="mono">tailscale serve --bg {data.port}</span> here and use
			<span class="mono">https://&lt;this-machine&gt;.&lt;tailnet&gt;.ts.net</span>.
		</p>
	</div>
</section>

<section class="card stack">
	<div class="card-header">
		<div>
			<h2>Snapshots</h2>
			<div class="card-sub">Consistent copies of your data in <span class="mono">{data.snapshotDir}</span></div>
		</div>
		<button type="button" class="btn btn-sm" disabled={busy} onclick={() => sync({ action: 'snapshot' })}><Icon name="database" size={16} />Take a snapshot now</button>
	</div>
	{#if data.snapshots.length}
		<div class="table-wrap">
			<table class="table">
				<thead><tr><th>When</th><th>Kind</th><th>Size</th><th>From</th><th><span class="sr-only">Actions</span></th></tr></thead>
				<tbody>
					{#each data.snapshots as s (s.id)}
						<tr>
							<td class="nowrap">{new Date(s.createdAt).toLocaleString()}<div class="tiny muted">{relativeTime(s.createdAt)}</div></td>
							<td>{typeLabel[s.type] ?? s.type}</td>
							<td class="mono">{size(s.size)}</td>
							<td>{s.mine ? 'This device' : s.source}</td>
							<td>
								{#if data.device.role === 'primary'}
									<button
										type="button"
										class="btn btn-sm btn-ghost"
										disabled={busy}
										onclick={() => {
											if (confirm('Replace your current data with this snapshot? What you have now is kept aside and saved in a “Before restore” snapshot.')) void sync({ action: 'restore-snapshot', id: s.id });
										}}>Restore</button
									>
								{/if}
							</td>
						</tr>
					{/each}
				</tbody>
			</table>
		</div>
	{:else}
		<p class="small muted">No snapshots yet. The first hourly one is made within a few minutes of a change.</p>
	{/if}
	<p class="hint">Don’t sync the live data folder with OneDrive, Dropbox or Syncthing while Medicus Vitae runs; copying a database mid-write can damage it. Use snapshots, exports and the other-device pairing instead.</p>
</section>

<style>
	.conflict {
		border-color: var(--weak-border);
		background: var(--weak-soft);
		color: var(--weak-text);
	}
	.conflict h2 {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}
	.held {
		background: var(--surface-2);
		border-radius: var(--radius);
		padding: 0.875rem 1rem;
	}
</style>
