<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '#lib/components/Icon.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let busy = $state(false);

	const submit = () => {
		busy = true;
		return async ({ update }: { update: (o?: { reset?: boolean }) => Promise<void> }) => {
			busy = false;
			await update({ reset: false });
		};
	};
</script>

<svelte:head><title>Sign in · Medicus Vitae</title></svelte:head>

<div class="card auth-card stack">
	{#if data.restored}
		<div class="notice"><Icon name="check" size={18} />Restored. Sign in with the password from that installation.</div>
	{/if}
	{#if data.standby}
		<div class="notice"><Icon name="database" size={18} />This device is a standby copy. Sign in with your usual password.</div>
	{/if}

	<div>
		<h1 style="font-size: 1.625rem">Sign in</h1>
		<p class="muted" style="margin-top: 0.25rem">Enter your Medicus Vitae password.</p>
	</div>
	<form method="POST" action="?/password" class="stack" use:enhance={submit}>
		<input type="hidden" name="next" value={data.next} />
		<div class="field">
			<label for="password">Password</label>
			<!-- svelte-ignore a11y_autofocus -->
			<input id="password" name="password" type="password" class="input" autocomplete="current-password" required autofocus />
		</div>
		{#if form?.error}<div class="error-box" role="alert"><Icon name="alert" size={18} />{form.error}</div>{/if}
		<button class="btn btn-primary btn-lg" disabled={busy}>{busy ? 'Checking…' : 'Sign in'}</button>
	</form>
</div>
