<script lang="ts">
	import { page } from '$app/state';
</script>

<svelte:head><title>{page.status} · Medicus Vitae</title></svelte:head>

<main class="err">
	<div class="card stack" style="max-width: 28rem; text-align: center; align-items: center">
		<div class="mono" style="font-size: 2.5rem; font-weight: 600">{page.status}</div>
		<h1 style="font-size: 1.375rem">{page.status === 404 ? 'Not found' : 'Something went wrong'}</h1>
		<p class="muted">{page.error?.message ?? 'An unexpected error happened.'}</p>
		<a class="btn btn-primary" href="/">Go to Today</a>
	</div>
</main>

<style>
	.err {
		min-height: 80vh;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 1rem;
	}
</style>
