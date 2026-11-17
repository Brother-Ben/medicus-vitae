<script lang="ts">
	import { goto, invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import TutorChat, { type ChatMessageView } from '#lib/components/TutorChat.svelte';
	import TutorTabs from '#lib/components/TutorTabs.svelte';
	import { api } from '#lib/client/api.js';
	import { relativeTime } from '#lib/dates.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	let threadId = $derived<string | null>(data.thread?.id ?? null);
	let messages = $derived<ChatMessageView[]>((data.thread?.messages ?? []) as ChatMessageView[]);
	// A new key per conversation so the chat starts fresh.
	const chatKey = $derived(data.thread?.id ?? `new:${data.question}:${data.context?.label ?? ''}:${data.mode}`);
	const researching = $derived(page.url.searchParams.get('mode') === 'research' && !data.thread);

	let deleting = $state<string | null>(null);
	let deleteOpen = $state(false);
	async function remove() {
		if (!deleting) return;
		await api(`/api/tutor/threads/${deleting}`, { method: 'DELETE' });
		if (data.thread?.id === deleting) await goto('/tutor');
		await invalidate('app:tutor');
	}
</script>

<svelte:head><title>Tutor · Medicus Vitae</title></svelte:head>

<div class="page">
	<header class="page-header">
		<div>
			<h1>Tutor</h1>
			<div class="subtitle">
				{#if data.provider}{data.provider.label} · {data.provider.model}{:else}Connect an AI service to ask questions.{/if}
			</div>
		</div>
	</header>

	<TutorTabs current={researching ? 'research' : 'ask'} pending={data.pending} quizCount={data.quizCount} />

	{#if !data.connected}
		<div class="card empty">
			<Icon name="sparkle" size={28} />
			<h2>No AI service connected</h2>
			<p>Use your Claude or ChatGPT plan, or add an API key (Claude, OpenAI, Gemini, OpenRouter). Everything else in Medicus Vitae works without one.</p>
			<a class="btn btn-primary" href="/settings/ai">Connect AI</a>
		</div>
	{:else}
		{#if researching && !data.canResearch}
			<div class="warning small"><Icon name="info" size={15} />The AI connection in use can’t search the web. Switch to a Claude, ChatGPT/OpenAI, Gemini or OpenRouter connection in Settings › AI.</div>
		{/if}
		<div class="layout">
			<aside class="threads card card-flush" aria-label="Conversations">
				<div class="threads-head">
					<a class="btn btn-sm" href={researching ? '/tutor?mode=research' : '/tutor'}><Icon name="plus" size={15} />New conversation</a>
				</div>
				<ul>
					{#each data.threads as t (t.id)}
						<li class:active={t.id === data.thread?.id}>
							<a href="/tutor?t={t.id}">
								<span class="truncate small strong">{#if t.mode === 'research'}<Icon name="globe" size={12} /> {/if}{t.title || 'Conversation'}</span>
								<span class="tiny muted truncate">{relativeTime(t.updatedAt)}{t.context?.label ? ` · ${t.context.label}` : ''}</span>
							</a>
							<button
								type="button"
								class="icon-btn plain sm"
								aria-label="Delete conversation"
								onclick={() => {
									deleting = t.id;
									deleteOpen = true;
								}}><Icon name="trash" size={14} /></button
							>
						</li>
					{:else}
						<li class="tiny muted" style="padding: 0.75rem">No conversations yet.</li>
					{/each}
				</ul>
			</aside>
			<section class="card chat" aria-label="Conversation">
				{#key chatKey}
					<TutorChat
						bind:threadId
						bind:messages
						context={data.thread?.context ?? data.context}
						initialQuestion={data.thread ? '' : data.question}
						initialMode={data.mode}
						canResearch={data.canResearch}
						onthread={(id) => {
							void goto(`/tutor?t=${id}`, { replace: true, reset: false });
							void invalidate('app:tutor');
						}}
					/>
				{/key}
			</section>
		</div>
	{/if}
</div>

<ConfirmDialog bind:open={deleteOpen} title="Delete this conversation?" confirmLabel="Delete" onconfirm={remove}>
	<p>The messages in it are removed. Cards and notes you made from it stay.</p>
</ConfirmDialog>

<style>
	.layout {
		display: grid;
		grid-template-columns: minmax(13rem, 17rem) minmax(0, 1fr);
		gap: 1rem;
		align-items: start;
	}
	@media (max-width: 900px) {
		.layout {
			grid-template-columns: 1fr;
		}
		.threads {
			order: 2;
		}
	}
	.threads {
		display: flex;
		flex-direction: column;
		max-height: calc(100dvh - 12rem);
	}
	.threads-head {
		padding: 0.625rem;
		border-bottom: 1px solid var(--border);
	}
	.threads ul {
		list-style: none;
		margin: 0;
		padding: 0.25rem;
		display: flex;
		flex-direction: column;
		gap: 1px;
		overflow-y: auto;
	}
	.threads li {
		display: flex;
		align-items: center;
		border-radius: var(--radius-sm);
	}
	.threads li.active,
	.threads li:hover {
		background: var(--surface-2);
	}
	.threads li a {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		padding: 0.4375rem 0.5rem;
		color: inherit;
		text-decoration: none;
	}
	.chat {
		height: calc(100dvh - 12rem);
		min-height: 28rem;
		display: flex;
		flex-direction: column;
	}
</style>
