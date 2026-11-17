<script lang="ts" module>
	import type { ChatContext, Citation, ClaimCheck } from '#lib/server/db/schema.js';

	export interface ChatMessageView {
		id: string;
		role: 'user' | 'assistant';
		text: string;
		mode: string | null;
		status: string;
		citations: Citation[];
		claims: ClaimCheck[];
		createdAt: number;
	}

	export type { ChatContext };
</script>

<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { ApiError, api } from '#lib/client/api.js';
	import { renderMarkdown } from '#lib/markdown.js';
	import type { AnchorInputClient } from '#lib/reader/anchors.js';
	import Icon from './Icon.svelte';

	// A conversation with the tutor (AI-01, AI-03). Answers come only from the
	// owner's material, with numbered citations that open the cited spot;
	// anything that failed a check is marked, and "not in your material" says so.

	let {
		threadId = $bindable(null),
		messages = $bindable([]),
		context = null,
		anchor = null,
		initialQuestion = '',
		compact = false,
		initialMode = 'guide',
		canResearch = true,
		onthread
	}: {
		threadId?: string | null;
		messages?: ChatMessageView[];
		context?: ChatContext | null;
		/** A reader selection not saved yet; saved with the first question. */
		anchor?: AnchorInputClient | null;
		initialQuestion?: string;
		compact?: boolean;
		initialMode?: 'guide' | 'explain' | 'research';
		/** Whether the connection in use can search the web. */
		canResearch?: boolean;
		onthread?: (id: string) => void;
	} = $props();

	let mode = $state<'guide' | 'explain' | 'research'>('guide');
	$effect.pre(() => {
		mode = initialMode === 'research' && !canResearch ? 'guide' : initialMode;
	});
	let input = $state('');
	let busy = $state(false);
	let phase = $state('');
	let error = $state<{ message: string; code: string | null; manageUrl: string | null } | null>(null);
	let list: HTMLDivElement | undefined = $state();
	let field: HTMLTextAreaElement | undefined = $state();

	const PHASES = ['Searching your material…', 'Writing an answer…', 'Checking the citations…', 'Still checking…'];
	const WEB_PHASES = ['Searching the web…', 'Reading sources…', 'Writing an answer…', 'Still researching…'];

	async function scrollDown() {
		await tick();
		list?.scrollTo({ top: list.scrollHeight, behavior: 'smooth' });
	}

	async function ask(question: string) {
		const q = question.trim();
		if (!q || busy) return;
		busy = true;
		error = null;
		input = '';
		const started = Date.now();
		const steps = mode === 'research' ? WEB_PHASES : PHASES;
		phase = steps[0];
		const timer = setInterval(() => {
			const s = (Date.now() - started) / 1000;
			phase = steps[s < 4 ? 0 : s < 15 ? 1 : s < 35 ? 2 : 3];
		}, 500);
		messages = [...messages, { id: `pending-${started}`, role: 'user', text: q, mode, status: 'answered', citations: [], claims: [], createdAt: started }];
		void scrollDown();
		try {
			const r = await api<{ threadId: string; user: ChatMessageView; answer: ChatMessageView }>('/api/tutor/ask', {
				body: { threadId, question: q, mode, context: threadId ? null : context, anchor: threadId ? null : anchor }
			});
			messages = [...messages.slice(0, -1), r.user, r.answer];
			if (threadId !== r.threadId) {
				threadId = r.threadId;
				onthread?.(r.threadId);
			}
		} catch (err) {
			messages = messages.slice(0, -1);
			input = q;
			const data = err instanceof ApiError ? err.data : null;
			error = {
				message: err instanceof Error ? err.message : String(err),
				code: (data?.code as string) ?? null,
				manageUrl: (data?.manageUrl as string) ?? null
			};
		} finally {
			clearInterval(timer);
			busy = false;
			phase = '';
			void scrollDown();
		}
	}

	function onKey(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
			e.preventDefault();
			void ask(input);
		}
	}

	function citeHref(c: Citation) {
		if (c.kind === 'web') return c.url && /^https?:\/\//.test(c.url) ? c.url : null;
		if ((c.kind === 'page' || c.kind === 'figure') && c.anchorId && c.documentId) return `/library/${c.documentId}/read?anchor=${c.anchorId}`;
		if (c.kind === 'card' && c.refId) return `/cards?note=${c.refId}`;
		if (c.kind === 'annotation' && c.documentId && c.page) return `/library/${c.documentId}/read?page=${c.page}`;
		if (c.kind === 'annotation') return '/notes';
		return null;
	}

	function escapeAttr(s: string) {
		return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
	}

	/** Markdown with [n] turned into links to the cited spot. */
	function answerHtml(m: ChatMessageView) {
		const html = renderMarkdown(m.text);
		return html.replace(/\[(\d{1,2})\]/g, (all, n: string) => {
			const c = m.citations.find((x) => x.n === Number(n));
			if (!c) return all;
			const href = citeHref(c);
			const weak = c.support === 'unsupported' || c.support === 'partial';
			const web = c.kind === 'web';
			const cls = `cite${weak ? ' weak' : ''}${web ? ' web' : ''}`;
			const title = escapeAttr(`${c.label}${weak ? ' · not fully backed by this passage' : ''}`);
			const target = web ? ' target="_blank" rel="noopener noreferrer"' : '';
			return href ? `<a class="${cls}" href="${escapeAttr(href)}" title="${title}"${target}>${n}</a>` : `<span class="${cls}" title="${title}">${n}</span>`;
		});
	}

	const SUPPORT_LABEL: Record<string, string> = {
		supported: 'Backed by the passage',
		partial: 'Only partly backed',
		unsupported: 'Not backed by the passage',
		unchecked: 'Couldn’t be checked',
		uncited: 'No source given'
	};

	onMount(() => {
		void scrollDown();
		if (initialQuestion.trim() && !messages.length) void ask(initialQuestion);
		else if (!compact) field?.focus();
	});
</script>

<div class="tutor" class:compact>
	<div class="tutor-head">
		<div class="segmented" role="radiogroup" aria-label="Tutor mode">
			<button type="button" role="radio" aria-checked={mode === 'guide'} onclick={() => (mode = 'guide')} title="Leading questions and pointers to the passage, from your material">Guide me</button>
			<button type="button" role="radio" aria-checked={mode === 'explain'} onclick={() => (mode = 'explain')} title="A direct explanation from your material, cited">Explain</button>
			<button
				type="button"
				role="radio"
				aria-checked={mode === 'research'}
				disabled={!canResearch}
				onclick={() => (mode = 'research')}
				title={canResearch ? 'Search the web, beyond your books, with links to every source' : 'The AI connection in use can’t search the web'}
			><Icon name="globe" size={14} />Research</button>
		</div>
		{#if context?.label}
			<span class="context-chip" title={context.label}><Icon name={context.kind === 'card' ? 'cards' : 'book'} size={13} stroke={2} />{context.label}</span>
		{/if}
	</div>

	<div class="messages" bind:this={list} aria-live="polite">
		{#if !messages.length && !busy}
			<div class="hello small muted">
				{#if mode === 'research'}
					<strong>Research</strong> goes beyond your material: it searches the web and links every source, so you can check it. Use it for things your books don’t cover.
				{:else}
					Ask about anything in your books, notes or cards. Answers come only from your material and cite where each point came from. <strong>Guide me</strong> nudges you toward the answer; <strong>Explain</strong> just explains; <strong>Research</strong> searches the web.
				{/if}
			</div>
		{/if}
		{#each messages as m (m.id)}
			{#if m.role === 'user'}
				<div class="msg user"><div class="bubble">{m.text}</div></div>
			{:else}
				<div class="msg assistant" class:not-found={m.status === 'not_found'} class:flagged={m.status === 'flagged'} class:web={m.mode === 'research'}>
					<div class="who tiny strong">
						<Icon name={m.mode === 'research' ? 'globe' : 'sparkle'} size={13} stroke={2} />Tutor{m.mode === 'explain' ? ' · Explain' : m.mode === 'guide' ? ' · Guide me' : m.mode === 'research' ? ' · Research' : ''}
					</div>
					{#if m.mode === 'research'}
						<div class="status-line small"><Icon name="info" size={15} />From the web, not your books. Check the sources.</div>
					{/if}
					{#if m.status === 'not_found'}
						<div class="status-line small"><Icon name="info" size={15} />Not in your material</div>
					{:else if m.status === 'flagged'}
						<div class="status-line warn small"><Icon name="alert" size={15} />Some of this isn’t fully backed by your material. Check the marked sources.</div>
					{/if}
					<div class="md answer">{@html answerHtml(m)}</div>
					{#if m.citations.length}
						<ol class="sources">
							{#each m.citations as c (c.n)}
								{@const href = citeHref(c)}
								<li class:weak={c.support === 'unsupported' || c.support === 'partial'}>
									<span class="num mono">{c.n}</span>
									<div class="src">
										{#if c.kind === 'web'}
											{#if href}<a {href} class="src-label" target="_blank" rel="noopener noreferrer">{c.label}<Icon name="external" size={12} /></a>{:else}<span class="src-label">{c.label}</span>{/if}
											<div class="tiny muted truncate">{c.url ? c.url.replace(/^https?:\/\/(www\.)?/, '').split('/')[0] : ''}</div>
											{#if c.exact}
												<details>
													<summary class="tiny muted">What it says</summary>
													<blockquote class="reading small">{c.exact.length > 600 ? c.exact.slice(0, 599) + '…' : c.exact}</blockquote>
												</details>
											{/if}
										{:else}
											{#if href}<a {href} class="src-label">{c.label}</a>{:else}<span class="src-label">{c.label}</span>{/if}
											<details>
												<summary class="tiny muted">{SUPPORT_LABEL[c.support] ?? c.support} · show text</summary>
												<blockquote class="reading small">{c.exact.length > 600 ? c.exact.slice(0, 599) + '…' : c.exact}</blockquote>
											</details>
										{/if}
									</div>
								</li>
							{/each}
						</ol>
					{/if}
					{#if m.claims.some((c) => c.kind === 'content' && c.support !== 'supported')}
						<details class="claims">
							<summary class="tiny">What the check found</summary>
							<ul>
								{#each m.claims.filter((c) => c.kind === 'content') as c, i (i)}
									<li class="small"><span class="pill pill-sm" class:pill-warn={c.support !== 'supported'}>{SUPPORT_LABEL[c.support] ?? c.support}</span> {c.text}{c.note ? ` — ${c.note}` : ''}</li>
								{/each}
							</ul>
						</details>
					{/if}
				</div>
			{/if}
		{/each}
		{#if busy}
			<div class="msg assistant thinking"><div class="who tiny strong"><Icon name="sparkle" size={13} stroke={2} />Tutor</div><div class="small muted">{phase}</div></div>
		{/if}
	</div>

	{#if error}
		<div class={error.code === 'usage_limit' || error.code === 'cap_reached' ? 'warning' : 'error-box'} role="alert">
			<Icon name="alert" size={18} />
			<div>
				{error.message}
				{#if error.manageUrl}
					<div style="margin-top: 0.375rem">
						{#if error.manageUrl.startsWith('http')}
							<a class="btn btn-sm" href={error.manageUrl} target="_blank" rel="noopener noreferrer">Manage usage<Icon name="external" size={14} /></a>
						{:else}
							<a class="btn btn-sm" href={error.manageUrl}>Open AI settings</a>
						{/if}
					</div>
				{/if}
			</div>
		</div>
	{/if}

	<form
		class="ask"
		onsubmit={(e) => {
			e.preventDefault();
			void ask(input);
		}}
	>
		<label for="tutor-input-{compact ? 'c' : 'f'}" class="sr-only">Ask the tutor</label>
		<textarea
			id="tutor-input-{compact ? 'c' : 'f'}"
			bind:this={field}
			class="textarea"
			rows={compact ? 2 : 3}
			placeholder={mode === 'guide' ? 'What are you stuck on?' : mode === 'explain' ? 'What should I explain?' : 'What should I look up?'}
			bind:value={input}
			onkeydown={onKey}
			disabled={busy}
		></textarea>
		<button class="btn btn-navy" disabled={busy || !input.trim()} aria-label="Ask"><Icon name="send" size={18} />{compact ? '' : 'Ask'}</button>
	</form>
</div>

<style>
	.tutor {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
		min-height: 0;
		height: 100%;
	}
	.tutor-head {
		display: flex;
		flex-wrap: wrap;
		gap: 0.5rem;
		align-items: center;
	}
	.context-chip {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.75rem;
		padding: 0.25rem 0.625rem;
		border-radius: 999px;
		background: var(--surface-2);
		color: var(--text-2);
	}
	.messages {
		flex: 1 1 auto;
		min-height: 8rem;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 0.875rem;
		padding-right: 0.25rem;
	}
	.hello {
		background: var(--surface-2);
		border-radius: var(--radius);
		padding: 0.75rem 0.875rem;
	}
	.msg.user {
		display: flex;
		justify-content: flex-end;
	}
	.msg.user .bubble {
		background: var(--ink);
		color: var(--on-ink);
		border-radius: 14px 14px 4px 14px;
		padding: 0.625rem 0.875rem;
		max-width: 85%;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}
	.msg.assistant {
		border-left: 3px solid var(--ink);
		padding: 0.125rem 0 0.125rem 0.875rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.msg.assistant.flagged {
		border-left-color: var(--weak);
	}
	.msg.assistant.not-found {
		border-left-color: var(--border-strong);
	}
	.msg.assistant.web {
		border-left-style: dashed;
	}
	.answer :global(.cite.web) {
		background: var(--surface-2);
		color: var(--text-2);
		outline: 1px solid var(--border-strong);
	}
	.src-label :global(svg) {
		vertical-align: -1px;
		margin-left: 0.25rem;
	}
	.who {
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
		color: var(--accent-text);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
	.status-line {
		display: inline-flex;
		gap: 0.375rem;
		align-items: center;
		color: var(--text-3);
	}
	.status-line.warn {
		color: var(--weak-text);
	}
	.answer {
		font-size: 0.9375rem;
		line-height: 1.55;
	}
	.answer :global(.cite) {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		min-width: 1.25rem;
		height: 1.25rem;
		padding: 0 0.25rem;
		margin: 0 0.0625rem;
		border-radius: 6px;
		font-size: 0.6875rem;
		font-weight: 700;
		font-family: var(--font-mono);
		background: var(--accent-soft);
		color: var(--accent-text);
		text-decoration: none;
		vertical-align: 0.125em;
	}
	.answer :global(.cite.weak) {
		background: var(--weak-soft);
		color: var(--weak-text);
		outline: 1px dashed var(--weak-border);
	}
	.sources {
		list-style: none;
		margin: 0;
		padding: 0;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.sources li {
		display: flex;
		gap: 0.5rem;
		align-items: flex-start;
		font-size: 0.8125rem;
	}
	.sources .num {
		flex: none;
		min-width: 1.25rem;
		height: 1.25rem;
		border-radius: 6px;
		background: var(--accent-soft);
		color: var(--accent-text);
		font-size: 0.6875rem;
		font-weight: 700;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.sources li.weak .num {
		background: var(--weak-soft);
		color: var(--weak-text);
	}
	.src {
		min-width: 0;
		flex: 1;
	}
	.src-label {
		font-weight: 600;
		color: var(--accent-text);
		text-decoration: none;
	}
	.src details summary {
		cursor: pointer;
	}
	.src blockquote {
		margin: 0.375rem 0 0;
		color: var(--text);
	}
	.claims summary {
		cursor: pointer;
		color: var(--weak-text);
	}
	.claims ul {
		margin: 0.375rem 0 0;
		padding-left: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.25rem;
	}
	.thinking {
		opacity: 0.85;
	}
	.ask {
		display: flex;
		gap: 0.5rem;
		align-items: flex-end;
	}
	.ask textarea {
		flex: 1;
		resize: vertical;
	}
	.compact .answer {
		font-size: 0.875rem;
	}
</style>
