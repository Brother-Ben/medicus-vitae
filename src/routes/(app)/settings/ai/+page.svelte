<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidate } from '$app/navigation';
	import { page } from '$app/state';
	import { onMount } from 'svelte';
	import Icon from '#lib/components/Icon.svelte';
	import { api } from '#lib/client/api.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import { relativeTime } from '#lib/dates.js';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	let signIn = $state<{ url: string; mode: 'direct' | 'paste' } | null>(null);
	let pasted = $state('');
	let completing = $state(false);
	let models = $state<{ slug: string; name: string }[]>([]);
	let qualityRunning = $derived(data.qualityRunning);
	let keyModels = $state<Record<string, { id: string; name: string }[]>>({});

	const money = (n: number | null) => (n === null ? '—' : `$${n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2)}`);
	const fmt = (n: number) => n.toLocaleString('en-US');

	const LABEL: Record<string, string> = {
		claude_code: 'Claude plan',
		chatgpt: 'ChatGPT plan',
		claude: 'Claude API',
		openai: 'OpenAI API',
		gemini: 'Gemini API',
		openrouter: 'OpenRouter',
		custom: 'Other service'
	};

	async function startChatgpt(forceConsent = false) {
		try {
			signIn = await api('/api/ai/chatgpt/start', { body: { forceConsent } });
			window.open(signIn!.url, '_blank', 'noopener');
		} catch (err) {
			toastError(err);
		}
	}

	async function completePaste() {
		completing = true;
		try {
			const r = await api<{ planUsage: boolean }>('/api/ai/chatgpt/complete', { body: { url: pasted } });
			signIn = null;
			pasted = '';
			toast(r.planUsage ? 'Signed in with ChatGPT' : 'Signed in, but plan usage wasn’t allowed');
			await invalidate('app:ai');
		} catch (err) {
			toastError(err);
		} finally {
			completing = false;
		}
	}

	async function loadModels() {
		try {
			models = (await api<{ models: { slug: string; name: string }[] }>('/api/ai/chatgpt/models')).models;
		} catch {
			models = [];
		}
	}

	async function loadKeyModels(id: string) {
		if (keyModels[id]?.length) return;
		try {
			keyModels[id] = (await api<{ models: { id: string; name: string }[] }>(`/api/ai/models?provider=${id}`)).models;
		} catch {
			keyModels[id] = [];
		}
	}

	async function runQuality() {
		if (!confirm('The quality check sends about 15 small requests to your AI service (from a built-in test library, not your books). Run it now?')) return;
		try {
			await api('/api/ai/quality', { body: {} });
			qualityRunning = { done: 0, total: 1 };
		} catch (err) {
			toastError(err);
		}
	}

	const saved = (message: string) => () => async ({ result, update }: { result: { type: string }; update: (o?: { reset?: boolean }) => Promise<void> }) => {
		await update({ reset: false });
		if (result.type === 'success') toast(message);
	};

	// Claude plan through Claude Code: found by asking the server to look (it runs `claude` a few times).
	interface CcAccount {
		configDir: string | null;
		folder: string;
		loggedIn: boolean;
		email: string | null;
		plan: string | null;
	}
	let cc = $state<{ exe: string | null; found: string[]; version: string | null; accounts: CcAccount[]; problem: string | null } | null>(null);
	let ccLooking = $state(false);
	let ccExe = $state('');
	let ccDir = $state('');
	let ccModel = $state('');

	async function findClaudeCode(exe?: string) {
		ccLooking = true;
		try {
			const r = await api<NonNullable<typeof cc>>(`/api/ai/claude-code${exe ? `?exe=${encodeURIComponent(exe)}` : ''}`);
			cc = r;
			ccExe = r.exe ?? exe ?? '';
			// The account chosen before, else the first one that's signed in.
			const chosen = data.claudeCode?.configDir ?? null;
			const match = r.accounts.find((a) => a.loggedIn && a.configDir === chosen) ?? r.accounts.find((a) => a.loggedIn);
			ccDir = match?.configDir ?? '';
		} catch (err) {
			toastError(err);
		} finally {
			ccLooking = false;
		}
	}

	const planLabel = (p: string | null) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : '');
	const folderName = (f: string) => f.split(/[\\/]/).pop() ?? f;

	onMount(() => {
		ccModel = data.claudeCode?.model ?? '';
		void findClaudeCode();
		if (page.url.searchParams.get('connected') === 'chatgpt') toast('Signed in with ChatGPT');
		if (data.chatgpt?.signedIn && data.chatgpt.planUsage) void loadModels();
		const t = setInterval(async () => {
			if (qualityRunning || data.index.state.phase !== 'idle') {
				await invalidate('app:ai');
			}
		}, 3000);
		return () => clearInterval(t);
	});

	const KEYS = [
		{
			id: 'claude' as const,
			name: 'Claude',
			help: 'An API key from the Claude Console (platform.claude.com). Billed to your API account. Research uses Claude’s web search ($10 per 1,000 searches).',
			models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
			keyUrl: 'https://platform.claude.com/settings/keys'
		},
		{ id: 'openai' as const, name: 'OpenAI', help: 'An API key from platform.openai.com. Billed to your API account.', models: ['gpt-5.5'], keyUrl: 'https://platform.openai.com/api-keys' },
		{
			id: 'gemini' as const,
			name: 'Google Gemini',
			help: 'A free key from Google AI Studio works (with daily limits); a paid key raises them. Research uses Google Search.',
			models: ['gemini-flash-latest', 'gemini-pro-latest'],
			keyUrl: 'https://aistudio.google.com/apikey'
		},
		{
			id: 'openrouter' as const,
			name: 'OpenRouter',
			help: 'One key for many models (Claude, GPT, Gemini, Llama, DeepSeek…), some free (names ending in :free). Prepaid credit; the cost of each request is tracked exactly.',
			models: ['openrouter/auto'],
			keyUrl: 'https://openrouter.ai/settings/keys'
		}
	];

	const openId = $derived(data.active ?? (data.claudeCode ? 'claude_code' : data.chatgpt?.signedIn ? 'chatgpt' : null));
	const status = (configured: boolean, id: string) => (data.active === id ? 'in-use' : configured ? 'ready' : 'off');
</script>

<svelte:head><title>AI · Settings · Medicus Vitae</title></svelte:head>

{#snippet testResult(id: string)}
	{#if form && 'tested' in form && form.tested === id}
		{#if form.ok}
			<div class="notice" role="status"><Icon name="check" size={16} />Connected · {form.model} answered in {((form.ms ?? 0) / 1000).toFixed(1)} s.</div>
		{:else}
			<div class="error-box" role="alert">
				<Icon name="alert" size={16} />
				<div>{form.error}{#if form.manageUrl?.startsWith('http')} <a href={form.manageUrl} target="_blank" rel="noopener noreferrer">Manage usage</a>{/if}</div>
			</div>
		{/if}
	{/if}
{/snippet}

{#snippet badge(state: string)}
	{#if state === 'in-use'}<span class="pill pill-sm pill-accent">In use</span>{:else if state === 'ready'}<span class="pill pill-sm">Connected</span>{/if}
{/snippet}

<section class="card card-flush">
	<div class="card-head">
		<h2>AI connection</h2>
		<p class="card-sub">The tutor, research, card generation and the CARS importer use one of these. Everything else works without AI. Only the passages picked for a question are sent, never whole books.</p>
	</div>

	<!-- Claude plan, through Claude Code -->
	<details class="conn" open={openId === 'claude_code'}>
		<summary>
			<span class="conn-name">Claude plan <span class="muted">· through Claude Code</span></span>
			{@render badge(status(data.claudeCodeReady, 'claude_code'))}
			<Icon name="chevron-down" size={16} class="chev" />
		</summary>
		<div class="conn-body">
			<p class="small muted">Uses your Claude Pro or Max plan by running Claude Code, Anthropic’s app, already signed in on this computer. No API key; Medicus Vitae never sees your Claude sign-in.</p>
			{#if !cc}
				<p class="small muted">{ccLooking ? 'Looking for Claude Code on this computer…' : 'Couldn’t check for Claude Code.'}</p>
			{:else if !cc.version}
				<div class="warning">
					<Icon name="alert" size={16} />
					<div>
						{cc.problem} Install Claude Code (<a href="https://code.claude.com/docs/en/setup" target="_blank" rel="noopener noreferrer">how</a>), open a terminal, run <span class="mono">claude</span> once and sign in. Or enter where its program is:
					</div>
				</div>
				<form
					class="row-tight"
					onsubmit={(e) => {
						e.preventDefault();
						void findClaudeCode(ccExe.trim() || undefined);
					}}
				>
					<label for="cc-exe" class="sr-only">Path to Claude Code’s claude program</label>
					<input id="cc-exe" class="input mono" style="flex: 1 1 20rem" bind:value={ccExe} placeholder="C:\Users\you\.local\bin\claude.exe" />
					<button class="btn btn-sm" disabled={ccLooking}>{ccLooking ? 'Looking…' : 'Look again'}</button>
				</form>
			{:else}
				<div class="small">Found Claude Code {cc.version} · <span class="mono">{cc.exe}</span></div>
				{#if !cc.accounts.some((a) => a.loggedIn)}
					<div class="warning">
						<Icon name="alert" size={16} />
						<div>Claude Code isn’t signed in yet. Run <span class="mono">claude</span> in a terminal, sign in, then <button type="button" class="link-btn" onclick={() => findClaudeCode(cc?.exe ?? undefined)}>look again</button>.</div>
					</div>
				{:else}
					<form method="POST" action="?/claudeCodeSave" class="stack-sm" use:enhance={saved(data.claudeCode ? 'Claude Code settings saved' : 'Claude Code connected')}>
						<input type="hidden" name="exe" value={cc.exe ?? ''} />
						<div class="form-grid">
							<div class="field">
								<label for="cc-account">Claude account</label>
								<select id="cc-account" name="configDir" class="select" bind:value={ccDir}>
									{#each cc.accounts as a (a.folder)}
										<option value={a.configDir ?? ''} disabled={!a.loggedIn}>
											{a.loggedIn ? `${a.email ?? 'Signed in'}${a.plan ? ` · ${planLabel(a.plan)}` : ''}` : 'Not signed in'} ({folderName(a.folder)})
										</option>
									{/each}
								</select>
							</div>
							<div class="field">
								<label for="cc-model">Model</label>
								<input id="cc-model" name="model" class="input mono" list="cc-models" bind:value={ccModel} placeholder="Claude Code’s default" />
								<datalist id="cc-models"><option value="opus"></option><option value="sonnet"></option><option value="haiku"></option><option value="fable"></option></datalist>
							</div>
						</div>
						<div class="row-tight">
							<button class="btn btn-sm btn-primary">{data.claudeCode ? 'Save' : 'Connect'}</button>
							{#if data.active !== 'claude_code'}<button class="btn btn-sm" name="makeActive" value="1">{data.claudeCode ? 'Save and use this' : 'Connect and use this'}</button>{/if}
						</div>
					</form>
				{/if}
				{#if data.claudeCode}
					<div class="row-tight">
						{#if data.active !== 'claude_code' && data.claudeCodeReady}
							<form method="POST" action="?/setActive" use:enhance={saved('Claude plan is now in use')}><input type="hidden" name="provider" value="claude_code" /><button class="btn btn-sm btn-primary">Use this</button></form>
						{/if}
						<form method="POST" action="?/test" use:enhance><input type="hidden" name="provider" value="claude_code" /><button class="btn btn-sm">Test connection</button></form>
						<form method="POST" action="?/claudeCodeForget" use:enhance={saved('Claude Code disconnected')}><button class="btn btn-sm btn-ghost">Disconnect</button></form>
						<a class="btn btn-sm btn-ghost" href="https://claude.ai/settings/usage" target="_blank" rel="noopener noreferrer">Plan usage<Icon name="external" size={13} /></a>
					</div>
					{@render testResult('claude_code')}
				{/if}
			{/if}
			<details class="small">
				<summary class="muted">How the Claude plan connection works</summary>
				<p style="margin-top: 0.5rem">
					Medicus Vitae runs your own copy of Claude Code in its non-interactive mode, with its tools off (Research turns on only web search and reading web pages), none of your Claude Code add-ons loaded, and nothing saved to its history. Claude Code signs in by itself;
					Medicus Vitae never sees or stores that sign-in. Each request counts toward your plan’s usage limits. Anthropic doesn’t allow apps to offer “Sign in with Claude” or handle Claude credentials, and Medicus Vitae does neither
					(<a href="https://code.claude.com/docs/en/legal-and-compliance" target="_blank" rel="noopener noreferrer">policy</a>).
				</p>
			</details>
		</div>
	</details>

	<!-- ChatGPT plan -->
	<details class="conn" open={openId === 'chatgpt'}>
		<summary>
			<span class="conn-name">ChatGPT plan <span class="muted">· Sign in with ChatGPT</span></span>
			{@render badge(status(data.chatgptReady, 'chatgpt'))}
			<Icon name="chevron-down" size={16} class="chev" />
		</summary>
		<div class="conn-body">
			<p class="small muted">Uses your ChatGPT Plus or Pro allowance through OpenAI’s “Sign in with ChatGPT” for open-source apps. No API key.</p>
			{#if data.chatgpt?.signedIn}
				<div class="small">
					Signed in{data.chatgpt.email ? ` as ${data.chatgpt.email}` : ''} · {relativeTime(data.chatgpt.connectedAt)}
					{#if !data.chatgpt.planUsage}
						<div class="warning" style="margin-top: 0.5rem"><Icon name="alert" size={16} /><div>Plan usage wasn’t allowed during sign-in. <button type="button" class="link-btn" onclick={() => startChatgpt(true)}>Sign in again and allow it</button></div></div>
					{/if}
				</div>
				{#if data.chatgpt.planUsage}
					<form method="POST" action="?/chatgptModel" class="row-tight" use:enhance={saved('Model saved')}>
						<label for="cg-model" class="small muted">Model</label>
						<select id="cg-model" name="model" class="select" style="width: 16rem">
							{#if !models.length}<option value={data.chatgpt.model ?? ''}>{data.chatgpt.model ?? 'Default'}</option>{/if}
							{#each models as m (m.slug)}<option value={m.slug} selected={m.slug === data.chatgpt.model}>{m.name}</option>{/each}
						</select>
						<button class="btn btn-sm">Save</button>
					</form>
				{/if}
				<div class="row-tight">
					{#if data.active !== 'chatgpt' && data.chatgptReady}
						<form method="POST" action="?/setActive" use:enhance={saved('ChatGPT plan is now in use')}><input type="hidden" name="provider" value="chatgpt" /><button class="btn btn-sm btn-primary">Use this</button></form>
					{/if}
					<form method="POST" action="?/test" use:enhance><input type="hidden" name="provider" value="chatgpt" /><button class="btn btn-sm">Test connection</button></form>
					<form method="POST" action="?/chatgptSignOut" use:enhance={saved('Signed out of ChatGPT')}><button class="btn btn-sm btn-ghost">Sign out</button></form>
					<a class="btn btn-sm btn-ghost" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener noreferrer">Manage usage<Icon name="external" size={13} /></a>
				</div>
				{@render testResult('chatgpt')}
			{:else}
				<button type="button" class="btn btn-navy" style="align-self: flex-start" onclick={() => startChatgpt()}><Icon name="sparkle" size={16} />Sign in with ChatGPT</button>
			{/if}
			{#if signIn}
				<div class="notice">
					<Icon name="info" size={16} />
					<div class="stack-sm" style="flex: 1">
						{#if signIn.mode === 'direct'}
							<div>A sign-in page opened in a new tab. After you approve, it comes back here by itself. If it shows an error page instead, copy that page’s full address and paste it below.</div>
						{:else}
							<div>A sign-in page opened in a new tab. Because Medicus Vitae runs on another computer, the last step lands on a page that won’t load (it starts with <span class="mono">http://127.0.0.1:1455</span>). Copy that whole address and paste it here.</div>
						{/if}
						<div class="row-tight">
							<input class="input" style="flex: 1" placeholder="http://127.0.0.1:…/auth/callback?code=…" bind:value={pasted} aria-label="Address from the sign-in page" />
							<button type="button" class="btn btn-sm btn-primary" disabled={!pasted.trim() || completing} onclick={completePaste}>Finish sign-in</button>
						</div>
						<a class="small" href={signIn.url} target="_blank" rel="noopener noreferrer">Open the sign-in page again</a>
					</div>
				</div>
			{/if}
		</div>
	</details>

	<!-- API keys -->
	{#each KEYS as p (p.id)}
		{@const info = data.keys[p.id]}
		<details class="conn" open={openId === p.id} ontoggle={(e) => (e.currentTarget as HTMLDetailsElement).open && (p.id === 'openrouter' || (p.id === 'gemini' && info.hasKey)) && loadKeyModels(p.id)}>
			<summary>
				<span class="conn-name">{p.name} <span class="muted">· API key</span></span>
				{@render badge(status(info.configured, p.id))}
				<Icon name="chevron-down" size={16} class="chev" />
			</summary>
			<div class="conn-body">
				<p class="small muted">{p.help} <a href={p.keyUrl} target="_blank" rel="noopener noreferrer">Get a key</a></p>
				<form method="POST" action="?/saveKey" class="stack-sm" use:enhance={saved(`${p.name} settings saved`)}>
					<input type="hidden" name="provider" value={p.id} />
					<div class="form-grid">
						<div class="field">
							<label for="{p.id}-key">API key</label>
							<input id="{p.id}-key" name="apiKey" type="password" autocomplete="off" class="input mono" placeholder={info.hint ? `Saved (${info.hint}). Blank keeps it.` : 'Paste your key'} />
							{#if info.source === 'env'}<span class="hint">Using the key from the .env file.</span>{/if}
						</div>
						<div class="field">
							<label for="{p.id}-model">Model</label>
							<input id="{p.id}-model" name="model" class="input mono" list="{p.id}-models" value={info.model} onfocus={() => (p.id === 'openrouter' || info.hasKey) && loadKeyModels(p.id)} />
							<datalist id="{p.id}-models">
								{#each [...new Set([...p.models, ...(keyModels[p.id] ?? []).map((m) => m.id)])] as m (m)}<option value={m}></option>{/each}
							</datalist>
						</div>
						<div class="field">
							<label for="{p.id}-cap">Monthly cap (US$)</label>
							<input id="{p.id}-cap" name="cap" type="number" min="0" step="0.5" class="input mono" value={info.cap ?? ''} placeholder="No cap" />
							<span class="hint">This month: {money(info.spend)}{info.cap !== null ? ` of ${money(info.cap)}` : ''}.</span>
						</div>
						{#if p.id !== 'openrouter'}
							<div class="field">
								<span class="label">Price per million tokens (in / out)</span>
								<div class="row-tight">
									<input name="inputPrice" type="number" min="0" step="0.01" class="input mono" style="width: 6rem" aria-label="Input price" value={info.inputPrice ?? ''} />
									<input name="outputPrice" type="number" min="0" step="0.01" class="input mono" style="width: 6rem" aria-label="Output price" value={info.outputPrice ?? ''} />
								</div>
								<span class="hint">{info.pricesKnown ? 'Used to track the cap.' : 'Unknown for this model: enter prices so the cap can be tracked.'}</span>
							</div>
						{/if}
					</div>
					<div class="row-tight">
						<button class="btn btn-sm btn-primary">Save</button>
						{#if info.configured && data.active !== p.id}<button class="btn btn-sm" name="makeActive" value="1">Save and use this</button>{/if}
					</div>
				</form>
				{#if info.configured}
					<div class="row-tight">
						{#if data.active !== p.id}
							<form method="POST" action="?/setActive" use:enhance={saved(`${p.name} is now in use`)}><input type="hidden" name="provider" value={p.id} /><button class="btn btn-sm btn-primary">Use this</button></form>
						{/if}
						<form method="POST" action="?/test" use:enhance><input type="hidden" name="provider" value={p.id} /><button class="btn btn-sm">Test connection</button></form>
						{#if info.source === 'saved'}
							<form method="POST" action="?/removeKey" use:enhance={saved('Key removed')}><input type="hidden" name="provider" value={p.id} /><button class="btn btn-sm btn-ghost">Remove key</button></form>
						{/if}
					</div>
					{@render testResult(p.id)}
				{/if}
			</div>
		</details>
	{/each}

	<!-- Any OpenAI-compatible service -->
	<details class="conn" open={openId === 'custom'}>
		<summary>
			<span class="conn-name">Other <span class="muted">· any OpenAI-compatible service</span></span>
			{@render badge(status(data.keys.custom.configured, 'custom'))}
			<Icon name="chevron-down" size={16} class="chev" />
		</summary>
		<div class="conn-body">
			<p class="small muted">
				Models running on this computer (Ollama: <span class="mono">http://localhost:11434/v1</span>, LM Studio: <span class="mono">http://localhost:1234/v1</span>) or other providers with an OpenAI-style API (DeepSeek, xAI, Mistral, Groq, Together…). Local models are free and private but weaker; Research isn’t available here.
			</p>
			<form method="POST" action="?/saveKey" class="stack-sm" use:enhance={saved('Service saved')}>
				<input type="hidden" name="provider" value="custom" />
				<div class="form-grid">
					<div class="field">
						<label for="custom-url">Address</label>
						<input id="custom-url" name="baseUrl" class="input mono" value={data.keys.custom.baseUrl} placeholder="http://localhost:11434/v1" />
					</div>
					<div class="field">
						<label for="custom-model">Model</label>
						<input id="custom-model" name="model" class="input mono" list="custom-models" value={data.keys.custom.model} placeholder="llama3.1:8b" onfocus={() => data.keys.custom.baseUrl && loadKeyModels('custom')} />
						<datalist id="custom-models">{#each keyModels.custom ?? [] as m (m.id)}<option value={m.id}></option>{/each}</datalist>
					</div>
					<div class="field">
						<label for="custom-key">API key <span class="muted">(if it needs one)</span></label>
						<input id="custom-key" name="apiKey" type="password" autocomplete="off" class="input mono" placeholder={data.keys.custom.hint ? `Saved (${data.keys.custom.hint}).` : 'Not needed for Ollama or LM Studio'} />
					</div>
					<div class="field">
						<label for="custom-cap">Monthly cap (US$)</label>
						<input id="custom-cap" name="cap" type="number" min="0" step="0.5" class="input mono" value={data.keys.custom.cap ?? ''} placeholder="No cap" />
						<span class="hint">Tracked only if you enter prices below.</span>
					</div>
					<div class="field">
						<span class="label">Price per million tokens (in / out)</span>
						<div class="row-tight">
							<input name="inputPrice" type="number" min="0" step="0.01" class="input mono" style="width: 6rem" aria-label="Input price" value={data.keys.custom.inputPrice ?? ''} />
							<input name="outputPrice" type="number" min="0" step="0.01" class="input mono" style="width: 6rem" aria-label="Output price" value={data.keys.custom.outputPrice ?? ''} />
						</div>
					</div>
				</div>
				<div class="row-tight">
					<button class="btn btn-sm btn-primary">Save</button>
					{#if data.keys.custom.configured && data.active !== 'custom'}<button class="btn btn-sm" name="makeActive" value="1">Save and use this</button>{/if}
				</div>
			</form>
			{#if data.keys.custom.configured}
				<div class="row-tight">
					{#if data.active !== 'custom'}
						<form method="POST" action="?/setActive" use:enhance={saved('Service is now in use')}><input type="hidden" name="provider" value="custom" /><button class="btn btn-sm btn-primary">Use this</button></form>
					{/if}
					<form method="POST" action="?/test" use:enhance><input type="hidden" name="provider" value="custom" /><button class="btn btn-sm">Test connection</button></form>
					<form method="POST" action="?/removeKey" use:enhance={saved('Service removed')}><input type="hidden" name="provider" value="custom" /><button class="btn btn-sm btn-ghost">Remove</button></form>
				</div>
				{@render testResult('custom')}
			{/if}
		</div>
	</details>

	{#if form && !('tested' in form) && 'error' in form && form.error}
		<div class="error-box" role="alert" style="margin: 0.75rem 1rem"><Icon name="alert" size={16} />{form.error}</div>
	{/if}
</section>

<section class="card stack">
	<h2>What each feature sends</h2>
	<div class="table-wrap">
		<table class="table">
			<thead><tr><th>Feature</th><th>What’s sent</th></tr></thead>
			<tbody>
				<tr><td>Tutor (Guide me, Explain)</td><td>Your question, the last few messages, and up to 8 short passages from your books, notes and cards</td></tr>
				<tr><td>Citation check</td><td>The tutor’s statements and the passages they cite</td></tr>
				<tr><td>Research the web</td><td>Your question, the last few messages, and the passage you asked about. The service searches the web with it{data.activeCanResearch ? '' : ' (not available with the connection in use)'}</td></tr>
				<tr><td>Generate cards, questions, notes</td><td>Up to 24 passages from the chosen chapter</td></tr>
				<tr><td>Match chapters to Anki tags</td><td>Chapter titles and the deck’s tag and subdeck names</td></tr>
				<tr><td>CARS import</td><td>The text of the page you sent, only when its layout isn’t one Medicus reads by itself</td></tr>
				<tr><td>Today: recap, suggestions, mistake patterns</td><td>A short summary of your study numbers and up to 12 mistake summaries, when you press the button</td></tr>
				<tr><td>Search index (meaning search)</td><td>Nothing: built on this device with a local model</td></tr>
			</tbody>
		</table>
	</div>
	<p class="small muted">Everything goes to {data.active ? LABEL[data.active] : 'no service until you connect one'}.</p>
	{#if data.usage.length}
		<div>
			<h3 style="margin-bottom: 0.375rem">This month</h3>
			<div class="table-wrap">
				<table class="table">
					<thead><tr><th>Service</th><th>Feature</th><th class="mono">Requests</th><th class="mono">Tokens in / out</th><th class="mono">Est. cost</th></tr></thead>
					<tbody>
						{#each data.usage as u (u.provider + u.feature)}
							<tr><td>{LABEL[u.provider] ?? u.provider}</td><td>{u.feature}</td><td class="mono">{fmt(u.requests)}</td><td class="mono">{fmt(u.input)} / {fmt(u.output)}</td><td class="mono">{u.cost === null ? 'plan' : money(u.cost)}</td></tr>
						{/each}
					</tbody>
				</table>
			</div>
		</div>
	{/if}
</section>

<section class="card stack">
	<div class="card-header">
		<div>
			<h2>Search index</h2>
			<p class="card-sub">Built on this device from your books, figures, notes and cards. Powers the tutor and Meaning search, with or without AI.</p>
		</div>
		<form method="POST" action="?/reindex" use:enhance={saved('Updating the index')}><button class="btn btn-sm">Update now</button></form>
	</div>
	<div class="tiles">
		<div><div class="stat-label">Passages</div><div class="mono stat">{fmt(data.index.total)}</div></div>
		<div><div class="stat-label">With meaning vectors</div><div class="mono stat">{fmt(data.index.embedded)}</div></div>
		<div><div class="stat-label">Figures &amp; tables</div><div class="mono stat">{fmt(data.index.kinds.figure ?? 0)}</div></div>
		<div><div class="stat-label">Cards &amp; notes</div><div class="mono stat">{fmt((data.index.kinds.card ?? 0) + (data.index.kinds.annotation ?? 0))}</div></div>
	</div>
	{#if data.index.state.phase !== 'idle'}
		<p class="small">{data.index.state.phase === 'error' ? `Last update failed: ${data.index.state.error}` : data.index.state.message || 'Updating…'}</p>
	{/if}
	<p class="tiny muted">
		Model {data.embeddingModel.id} (revision {data.embeddingModel.revision}, {data.embeddingModel.dims} dimensions, {data.embeddingModel.distance}), on this computer’s CPU.
		{#if !data.index.vectors}Meaning search is off here; keyword search is used instead.{/if}
	</p>
</section>

<section class="card stack">
	<div class="card-header">
		<div>
			<h2>Quality check</h2>
			<p class="card-sub">A fixed test set: answerable and unanswerable questions, misleading passages, instructions hidden in book text, a deliberately wrong answer key. Run it after changing model or service.</p>
		</div>
		<button type="button" class="btn btn-sm" disabled={!data.active || !!qualityRunning} onclick={runQuality}>{qualityRunning ? `Running ${qualityRunning.done}/${qualityRunning.total}…` : 'Run check'}</button>
	</div>
	{#if data.quality}
		<p class="small">
			<strong>{data.quality.passed} of {data.quality.total} passed</strong> · {data.quality.provider} {data.quality.model} · prompts {data.quality.promptVersion} · {relativeTime(data.quality.ranAt)}
		</p>
		{#if data.quality.error}<div class="warning"><Icon name="alert" size={16} />{data.quality.error}</div>{/if}
		<div class="row-tight">
			{#each Object.entries(data.quality.byCategory) as [cat, b] (cat)}
				<span class="pill pill-sm" class:pill-warn={b.passed < b.total}>{cat}: {b.passed}/{b.total}</span>
			{/each}
		</div>
		{#if data.quality.items.some((i) => !i.pass)}
			<ul class="small">
				{#each data.quality.items.filter((i) => !i.pass) as i (i.id)}<li><span class="mono">{i.id}</span> {i.note || i.status}</li>{/each}
			</ul>
		{/if}
	{:else}
		<p class="small muted">Not run yet.</p>
	{/if}
</section>

<style>
	.conn {
		border-top: 1px solid var(--border);
	}
	.conn > summary {
		list-style: none;
		display: flex;
		align-items: center;
		gap: 0.625rem;
		padding: 0.75rem 1rem;
		cursor: pointer;
	}
	.conn > summary::-webkit-details-marker {
		display: none;
	}
	.conn > summary:hover {
		background: var(--hover);
	}
	.conn-name {
		flex: 1 1 auto;
		font-weight: 600;
	}
	.conn > summary :global(.chev) {
		color: var(--text-3);
		transition: transform 0.15s;
	}
	.conn[open] > summary :global(.chev) {
		transform: rotate(180deg);
	}
	.conn-body {
		padding: 0.25rem 1rem 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.tiles {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
		gap: 0.75rem;
	}
	.stat {
		font-size: 1.25rem;
		font-weight: 600;
	}
	.link-btn {
		background: none;
		border: 0;
		padding: 0;
		color: var(--accent-text);
		font: inherit;
		cursor: pointer;
		text-decoration: underline;
	}
</style>
