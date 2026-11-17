import fs from 'node:fs';
import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { chatgptAccount, PLAN_SCOPE, setChatgptModel, signOut } from '#lib/server/ai/chatgpt.js';
import { claudeCodeSettings, forgetClaudeCode, saveClaudeCodeSettings } from '#lib/server/ai/claude-code.js';
import { indexSummary, requestIndex } from '#lib/server/ai/indexer.js';
import { EMBEDDING_MODEL } from '#lib/server/ai/index-db.js';
import { lastQualityReport, qualityProgress } from '#lib/server/ai/quality.js';
import {
	activeProviderId,
	AiError,
	apiKeyProvider,
	canResearch,
	complete,
	DEFAULT_MODELS,
	KEY_PROVIDERS,
	keyFor,
	KNOWN_PRICES,
	monthSpend,
	monthUsage,
	PROVIDER_IDS,
	providerConfigured,
	setActiveProvider,
	type KeyProviderId,
	type ProviderId
} from '#lib/server/ai/providers.js';
import { db } from '#lib/server/db/index.js';
import { aiProvider } from '#lib/server/db/schema.js';
import type { Actions, PageServerLoad } from './$types';

const ENV: Record<KeyProviderId, string[]> = {
	claude: ['ANTHROPIC_API_KEY'],
	openai: ['OPENAI_API_KEY'],
	gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
	openrouter: ['OPENROUTER_API_KEY'],
	custom: []
};

function keyInfo(id: KeyProviderId) {
	const row = apiKeyProvider(id);
	const key = keyFor(id);
	const fromEnv = !row?.apiKey && ENV[id].some((n) => process.env[n]?.trim());
	const model = row?.model || DEFAULT_MODELS[id];
	return {
		configured: providerConfigured(id),
		hasKey: !!key,
		source: row?.apiKey ? ('saved' as const) : fromEnv ? ('env' as const) : null,
		hint: key ? `…${key.slice(-4)}` : null,
		model,
		baseUrl: row?.baseUrl ?? '',
		cap: row?.monthlyCapUsd ?? null,
		inputPrice: row?.inputPrice ?? KNOWN_PRICES[model]?.input ?? null,
		outputPrice: row?.outputPrice ?? KNOWN_PRICES[model]?.output ?? null,
		pricesKnown: row?.inputPrice != null || !!KNOWN_PRICES[model],
		spend: monthSpend(id)
	};
}

export const load: PageServerLoad = ({ depends }) => {
	depends('app:ai');
	const account = chatgptAccount();
	const active = activeProviderId();
	return {
		active,
		activeCanResearch: canResearch(active),
		claudeCode: claudeCodeSettings(),
		claudeCodeReady: providerConfigured('claude_code'),
		chatgpt: account
			? {
					email: account.email,
					name: account.name,
					signedIn: !!account.refreshToken,
					planUsage: account.scopes.includes(PLAN_SCOPE),
					model: account.model,
					connectedAt: account.connectedAt
				}
			: null,
		chatgptReady: providerConfigured('chatgpt'),
		keys: Object.fromEntries(KEY_PROVIDERS.map((id) => [id, keyInfo(id)])) as Record<KeyProviderId, ReturnType<typeof keyInfo>>,
		usage: monthUsage(),
		index: indexSummary(),
		embeddingModel: { id: EMBEDDING_MODEL.id, dims: EMBEDDING_MODEL.dims, distance: EMBEDDING_MODEL.distance, revision: EMBEDDING_MODEL.revision.slice(0, 7) },
		quality: lastQualityReport(),
		qualityRunning: qualityProgress()
	};
};

function num(v: FormDataEntryValue | null): number | null {
	const s = String(v ?? '').trim();
	if (!s) return null;
	const n = Number(s);
	return Number.isFinite(n) && n >= 0 ? n : null;
}

const isKeyProvider = (id: string): id is KeyProviderId => (KEY_PROVIDERS as string[]).includes(id);

export const actions: Actions = {
	saveKey: async ({ request }) => {
		const f = await request.formData();
		const id = String(f.get('provider'));
		if (!isKeyProvider(id)) return fail(400, { error: 'Unknown provider.' });
		const typed = String(f.get('apiKey') ?? '').trim();
		const existing = apiKeyProvider(id);
		const apiKey = typed || existing?.apiKey || null;
		if (typed && id !== 'custom' && (typed.length < 20 || /\s/.test(typed))) return fail(400, { error: 'That doesn’t look like an API key.', provider: id });
		const model = String(f.get('model') ?? '').trim() || DEFAULT_MODELS[id];
		let baseUrl: string | null = null;
		if (id === 'custom') {
			baseUrl = String(f.get('baseUrl') ?? '').trim().replace(/\/+$/, '') || null;
			if (!baseUrl || !/^https?:\/\/[^\s]+$/i.test(baseUrl)) return fail(400, { error: 'Enter the service’s address, like http://localhost:11434/v1', provider: id });
			if (!model) return fail(400, { error: 'Enter the model to use (its name on that service).', provider: id });
		}
		if (model && !/^[\w.:@/\-+ ]{1,120}$/.test(model)) return fail(400, { error: 'That doesn’t look like a model name.', provider: id });
		const values = {
			apiKey,
			model,
			baseUrl,
			monthlyCapUsd: num(f.get('cap')),
			inputPrice: num(f.get('inputPrice')),
			outputPrice: num(f.get('outputPrice')),
			updatedAt: Date.now()
		};
		db()
			.insert(aiProvider)
			.values({ id, ...values, createdAt: Date.now() })
			.onConflictDoUpdate({ target: aiProvider.id, set: values })
			.run();
		if ((!activeProviderId() || f.get('makeActive')) && providerConfigured(id)) setActiveProvider(id);
		return { saved: id };
	},

	removeKey: async ({ request }) => {
		const id = String((await request.formData()).get('provider'));
		if (!isKeyProvider(id)) return fail(400, { error: 'Unknown provider.' });
		if (id === 'custom') db().delete(aiProvider).where(eq(aiProvider.id, id)).run();
		else db().update(aiProvider).set({ apiKey: null, updatedAt: Date.now() }).where(eq(aiProvider.id, id)).run();
		return { removed: id };
	},

	claudeCodeSave: async ({ request }) => {
		const f = await request.formData();
		const exe = String(f.get('exe') ?? '').trim() || null;
		const configDir = String(f.get('configDir') ?? '').trim() || null;
		const model = String(f.get('model') ?? '').trim() || null;
		if (exe && !fs.existsSync(exe)) return fail(400, { error: 'There’s no program at that path.' });
		if (configDir && !fs.existsSync(configDir)) return fail(400, { error: 'That Claude Code settings folder doesn’t exist.' });
		if (model && !/^[\w.:@/-]{2,80}$/.test(model)) return fail(400, { error: 'That doesn’t look like a model name.' });
		saveClaudeCodeSettings({ exe, configDir, model, connectedAt: claudeCodeSettings()?.connectedAt });
		if (!activeProviderId() || f.get('makeActive')) setActiveProvider('claude_code');
		return { saved: 'claude_code' };
	},

	claudeCodeForget: async () => {
		forgetClaudeCode();
		if (activeProviderId() === null) setActiveProvider(null);
		return { removed: 'claude_code' };
	},

	setActive: async ({ request }) => {
		const id = String((await request.formData()).get('provider'));
		if (!(PROVIDER_IDS as string[]).includes(id)) return fail(400, { error: 'Unknown provider.' });
		if (!providerConfigured(id as ProviderId)) return fail(400, { error: 'Connect that service first.' });
		setActiveProvider(id as ProviderId);
		return { active: id };
	},

	chatgptModel: async ({ request }) => {
		const model = String((await request.formData()).get('model') ?? '').trim();
		setChatgptModel(model || null);
		return { saved: 'chatgpt' };
	},

	chatgptSignOut: async () => {
		const r = await signOut();
		if (activeProviderId() === null) setActiveProvider(null);
		return { signedOut: true, revoked: r.revoked };
	},

	test: async ({ request }) => {
		const id = String((await request.formData()).get('provider')) as ProviderId;
		const started = Date.now();
		try {
			const r = await complete(
				{ feature: 'check', system: 'You are a connection test. Reply with the single word OK.', messages: [{ role: 'user', content: 'Connection test.' }], maxTokens: 400, effort: 'low' },
				id
			);
			return { tested: id, ok: true, model: r.model, ms: Date.now() - started };
		} catch (err) {
			const e = err instanceof AiError ? err : null;
			return fail(400, { tested: id, ok: false, error: err instanceof Error ? err.message : String(err), manageUrl: e?.manageUrl ?? null });
		}
	},

	reindex: async () => {
		requestIndex();
		return { reindexing: true };
	}
};
