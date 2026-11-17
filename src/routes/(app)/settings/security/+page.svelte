<script lang="ts">
	import { enhance } from '$app/forms';
	import Icon from '#lib/components/Icon.svelte';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();

	async function signOut() {
		await fetch('/api/auth/logout', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
		location.href = '/login';
	}
</script>

<svelte:head><title>Security · Settings · Medicus Vitae</title></svelte:head>

<section class="card stack">
	<h2>Password</h2>
	<form method="POST" action="?/password" class="stack" use:enhance={() => async ({ update }) => update()}>
		<div class="form-grid">
			<div class="field"><label for="current">Current password</label><input id="current" name="current" type="password" class="input" autocomplete="current-password" required /></div>
			<div class="field"><label for="next">New password</label><input id="next" name="next" type="password" class="input" autocomplete="new-password" minlength="8" required /></div>
			<div class="field"><label for="confirm">Confirm new password</label><input id="confirm" name="confirm" type="password" class="input" autocomplete="new-password" minlength="8" required /></div>
		</div>
		{#if form?.form === 'password' && 'error' in form}<div class="error-box" role="alert"><Icon name="alert" size={18} />{form.error}</div>{/if}
		{#if form?.form === 'password' && 'ok' in form}<div class="notice"><Icon name="check" size={18} />Password changed. Other browsers were signed out.</div>{/if}
		<div><button class="btn">Change password</button></div>
	</form>
</section>

<section class="card stack">
	<h2>Sign out</h2>
	<p class="muted small">Sign out of this browser. Medicus Vitae keeps running; use Quit Medicus in the sidebar to stop it.</p>
	<div><button type="button" class="btn" onclick={signOut}><Icon name="logout" size={18} />Sign out</button></div>
</section>
