import Anthropic from '@anthropic-ai/sdk';
import type { BetaMessageStreamParams } from '@anthropic-ai/sdk/resources/beta/messages/messages';
import { eq } from 'drizzle-orm';
import { db, sqlite } from '../db';
import { aiProvider, aiUsage, user } from '../db/schema';
import { uuidv7 } from '../ids';
import { accessToken, chatgptAccount, chatgptReady, ChatgptError, MANAGE_USAGE_URL, markSignedOut } from './chatgpt';
import { claudeCodeRun, claudeCodeSettings, ClaudeCodeError, resolveClaudeExe } from './claude-code';

// AI connections (AI-07): a Claude plan through the Claude Code app on this
// computer, ChatGPT plan sign-in, or an API key for Claude, OpenAI, Google
// Gemini or OpenRouter, or any OpenAI-compatible service (Ollama, LM Studio,
// DeepSeek, xAIâ€¦), each with an optional monthly spending cap. Everything else in
// the app talks to `complete()` (and the tutor's web research to `research()`)
// and never needs to know which one is in use.
//
// There is no "Sign in with Claude": Anthropic's terms don't allow apps to offer
// Claude.ai login or handle its credentials. The Claude plan connection runs
// the owner's own signed-in Claude Code instead (see claude-code.ts).

export type ProviderId = 'claude_code' | 'chatgpt' | 'claude' | 'openai' | 'gemini' | 'openrouter' | 'custom';
/** Connections set up with an API key (and, for "custom", an address). */
export type KeyProviderId = 'claude' | 'openai' | 'gemini' | 'openrouter' | 'custom';
export const KEY_PROVIDERS: KeyProviderId[] = ['claude', 'openai', 'gemini', 'openrouter', 'custom'];
export const PROVIDER_IDS: ProviderId[] = ['claude_code', 'chatgpt', 'claude', 'openai', 'gemini', 'openrouter', 'custom'];
export type Feature = 'tutor' | 'check' | 'generate' | 'quality' | 'insights' | 'research';

export const PROVIDER_LABELS: Record<ProviderId, string> = {
	claude_code: 'Claude plan (Claude Code)',
	chatgpt: 'ChatGPT plan',
	claude: 'Claude (API key)',
	openai: 'OpenAI (API key)',
	gemini: 'Google Gemini (API key)',
	openrouter: 'OpenRouter (API key)',
	custom: 'Other (OpenAI-compatible)'
};

export const DEFAULT_MODELS: Record<KeyProviderId, string> = {
	claude: 'claude-opus-5-5',
	openai: 'gpt-5.5',
	gemini: 'gemini-flash-latest',
	openrouter: 'openrouter/auto',
	custom: ''
};

/** US dollars per million tokens, used for the monthly cap. Editable in Settings for anything not listed. */
export const KNOWN_PRICES: Record<string, { input: number; output: number }> = {
	'claude-opus-5-5': { input: 4, output: 20 },
	'claude-sonnet-5-5': { input: 2, output: 10 },
	'claude-haiku-5-5': { input: 0.1, output: 0.5 },
	'claude-opus-5': { input: 5, output: 25 },
	'claude-fable-5-1': { input: 10, output: 50 },
	'gpt-5.5': { input: 5, output: 30 }
};

/** Web searches billed per search on API keys (Claude: $10 per 1,000). */
const SEARCH_PRICE: Partial<Record<ProviderId, number>> = { claude: 0.01, openai: 0.01 };

export const MANAGE_URLS: Record<ProviderId, string> = {
	claude_code: 'https://claude.ai/settings/usage',
	chatgpt: MANAGE_USAGE_URL,
	claude: 'https://platform.claude.com/settings/billing',
	openai: 'https://platform.openai.com/settings/organization/billing/overview',
	gemini: 'https://aistudio.google.com/usage',
	openrouter: 'https://openrouter.ai/settings/credits',
	custom: '/settings/ai'
};

const ENV_KEYS: Record<KeyProviderId, string[]> = {
	claude: ['ANTHROPIC_API_KEY'],
	openai: ['OPENAI_API_KEY'],
	gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
	openrouter: ['OPENROUTER_API_KEY'],
	custom: []
};

export type AiErrorCode = 'not_connected' | 'usage_limit' | 'cap_reached' | 'auth' | 'refused' | 'unavailable' | 'bad_request' | 'network' | 'truncated';

export class AiError extends Error {
	constructor(
		message: string,
		public code: AiErrorCode,
		public manageUrl: string | null = null
	) {
		super(message);
	}
}

export interface AiMessage {
	role: 'user' | 'assistant';
	content: string;
}

export interface AiRequest {
	feature: Feature;
	system: string;
	messages: AiMessage[];
	/** JSON Schema for a structured (JSON) answer. */
	schema?: Record<string, unknown>;
	maxTokens?: number;
	effort?: 'low' | 'medium' | 'high';
}

export interface AiResponse {
	text: string;
	json: unknown;
	provider: ProviderId;
	model: string;
	inputTokens: number;
	outputTokens: number;
	costUsd: number | null;
}

export type ApiKeyProvider = typeof aiProvider.$inferSelect;

export function apiKeyProvider(id: KeyProviderId): ApiKeyProvider | null {
	return db().select().from(aiProvider).where(eq(aiProvider.id, id)).get() ?? null;
}

/** An API key from the UI, or else from the environment (.env next to the Compose file). */
export function keyFor(id: KeyProviderId): string | null {
	const row = apiKeyProvider(id);
	if (row?.apiKey) return row.apiKey;
	for (const name of ENV_KEYS[id]) {
		const v = process.env[name]?.trim();
		if (v) return v;
	}
	return null;
}

/** The "Other" service's address, like http://localhost:11434/v1. */
export function customBaseUrl(): string | null {
	const u = apiKeyProvider('custom')?.baseUrl?.trim();
	return u ? u.replace(/\/+$/, '') : null;
}

export function providerConfigured(id: ProviderId): boolean {
	if (id === 'claude_code') {
		const s = claudeCodeSettings();
		return !!s && resolveClaudeExe(s) !== null;
	}
	if (id === 'chatgpt') return chatgptReady();
	// A local service (Ollama, LM Studio) often needs no key: an address and a model are enough.
	if (id === 'custom') return !!customBaseUrl() && !!apiKeyProvider('custom')?.model;
	return !!keyFor(id);
}

export function activeProviderId(): ProviderId | null {
	if (testMode) return 'claude';
	const u = db().select({ p: user.aiProvider }).from(user).where(eq(user.id, 1)).get();
	const chosen = (u?.p ?? null) as ProviderId | null;
	if (chosen && chosen in PROVIDER_LABELS && providerConfigured(chosen)) return chosen;
	// Fall back to whatever is connected, plans first, in a fixed order.
	for (const id of PROVIDER_IDS) if (providerConfigured(id)) return id;
	return null;
}

export function setActiveProvider(id: ProviderId | null) {
	db().update(user).set({ aiProvider: id, updatedAt: Date.now() }).where(eq(user.id, 1)).run();
}

/** Whether the tutor and generation are available (AI connected). Non-AI features never depend on this. */
export function aiConnected() {
	try {
		return activeProviderId() !== null;
	} catch {
		return false;
	}
}

export function modelFor(id: ProviderId): string {
	if (id === 'claude_code') return claudeCodeSettings()?.model || 'Claude Codeâ€™s default model';
	if (id === 'chatgpt') return chatgptAccount()?.model ?? 'gpt-5.5';
	return apiKeyProvider(id)?.model || DEFAULT_MODELS[id];
}

/** Whether a connection can search the web (the tutor's Research mode). */
export function canResearch(id: ProviderId | null): boolean {
	return !!id && id !== 'custom';
}

function month(ms = Date.now()) {
	return new Date(ms).toISOString().slice(0, 7);
}

export function monthSpend(id: ProviderId, m = month()): number {
	return (
		sqlite().prepare('SELECT coalesce(sum(cost_usd), 0) AS c FROM ai_usage WHERE provider = ? AND month = ?').get(id, m) as { c: number }
	).c;
}

export function monthUsage(m = month()) {
	return sqlite()
		.prepare(
			`SELECT provider, feature, count(*) AS requests, sum(input_tokens) AS input, sum(output_tokens) AS output, sum(cost_usd) AS cost
			 FROM ai_usage WHERE month = ? GROUP BY provider, feature ORDER BY provider, feature`
		)
		.all(m) as { provider: string; feature: string; requests: number; input: number; output: number; cost: number | null }[];
}

function pricesFor(id: ProviderId, model: string) {
	if (id === 'chatgpt' || id === 'claude_code') return null;
	const row = apiKeyProvider(id);
	if (row?.inputPrice != null && row?.outputPrice != null) return { input: row.inputPrice, output: row.outputPrice };
	return KNOWN_PRICES[model] ?? null;
}

function record(req: { feature: Feature }, res: Omit<AiResponse, 'costUsd' | 'json' | 'text'>, extra: { costUsd?: number | null; searches?: number } = {}): number | null {
	const prices = pricesFor(res.provider, res.model);
	let cost = extra.costUsd !== undefined ? extra.costUsd : prices ? (res.inputTokens * prices.input + res.outputTokens * prices.output) / 1_000_000 : null;
	if (extra.searches && SEARCH_PRICE[res.provider] && cost !== null) cost += extra.searches * SEARCH_PRICE[res.provider]!;
	try {
		db()
			.insert(aiUsage)
			.values({
				id: uuidv7(),
				provider: res.provider,
				model: res.model,
				feature: req.feature,
				inputTokens: res.inputTokens,
				outputTokens: res.outputTokens,
				costUsd: cost,
				month: month(),
				createdAt: Date.now()
			})
			.run();
	} catch {
		// A standby can't record usage (read-only); the request already happened.
	}
	return cost;
}

function checkCap(id: ProviderId) {
	if (id === 'chatgpt' || id === 'claude_code') return;
	const row = apiKeyProvider(id);
	if (row?.monthlyCapUsd != null && monthSpend(id) >= row.monthlyCapUsd) {
		throw new AiError(
			`This monthâ€™s ${PROVIDER_LABELS[id]} spending has reached the $${row.monthlyCapUsd.toFixed(2)} cap you set. Raise the cap in Settings â€º AI, or wait until next month.`,
			'cap_reached',
			'/settings/ai'
		);
	}
}

/** Pulls the JSON object out of a model's text (tolerating code fences or a sentence around it). */
export function parseJson(text: string): unknown {
	const t = text.trim();
	try {
		return JSON.parse(t);
	} catch {
		const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(t);
		if (fenced) {
			try {
				return JSON.parse(fenced[1]);
			} catch {
				// fall through
			}
		}
		const start = t.indexOf('{');
		const end = t.lastIndexOf('}');
		if (start !== -1 && end > start) {
			try {
				return JSON.parse(t.slice(start, end + 1));
			} catch {
				// fall through
			}
		}
		throw new AiError('The AIâ€™s answer wasnâ€™t in the expected format. Try again.', 'bad_request');
	}
}

const jsonInstruction = (schema: Record<string, unknown>) => `\n\nReply with a single JSON object only, matching this JSON Schema:\n${JSON.stringify(schema)}`;

// ------------------------------------------------------------------ Claude

let claudeFallbacksOk = true;

function claudeClient() {
	const key = keyFor('claude');
	if (!key) throw new AiError('Add a Claude API key in Settings â€º AI first.', 'not_connected', '/settings/ai');
	return new Anthropic({ apiKey: key, maxRetries: 2, timeout: 10 * 60_000 });
}

/** One streamed request; retried without the fallback beta when an account doesn't have it. */
async function claudeStream(client: Anthropic, params: BetaMessageStreamParams): Promise<Anthropic.Beta.BetaMessage> {
	try {
		if (claudeFallbacksOk) {
			try {
				// If a safety check declines the request, the API retries it on a fallback model.
				return await client.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } as BetaMessageStreamParams).finalMessage();
			} catch (err) {
				if (err instanceof Anthropic.BadRequestError && /fallback/i.test(err.message)) {
					claudeFallbacksOk = false;
					return await client.beta.messages.stream(params).finalMessage();
				}
				throw err;
			}
		}
		return await client.beta.messages.stream(params).finalMessage();
	} catch (err) {
		throw claudeError(err);
	}
}

function claudeUsage(message: Anthropic.Beta.BetaMessage) {
	const usage = message.usage;
	return { inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), outputTokens: usage.output_tokens ?? 0 };
}

async function claudeComplete(req: AiRequest): Promise<AiResponse> {
	const client = claudeClient();
	const model = modelFor('claude');
	const message = await claudeStream(client, {
		model,
		max_tokens: req.maxTokens ?? 16000,
		system: req.system,
		messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
		output_config: { effort: req.effort ?? 'medium', ...(req.schema ? { format: { type: 'json_schema' as const, schema: req.schema } } : {}) }
	});
	if (message.stop_reason === 'refusal') throw new AiError('Claude declined to answer this request.', 'refused');
	const text = message.content
		.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text')
		.map((b) => b.text)
		.join('');
	if (message.stop_reason === 'max_tokens' && req.schema) throw new AiError('The answer was cut off before it finished. Try a shorter request.', 'truncated');
	const base = { provider: 'claude' as const, model: message.model || model, ...claudeUsage(message) };
	const costUsd = record(req, base);
	return { ...base, text, json: req.schema ? parseJson(text) : null, costUsd };
}

function claudeError(err: unknown): AiError {
	if (err instanceof AiError) return err;
	if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
		return new AiError('Claude rejected the API key. Check it in Settings â€º AI.', 'auth', '/settings/ai');
	}
	if (err instanceof Anthropic.RateLimitError) {
		return new AiError('Claudeâ€™s rate limit for your API key was reached. Wait a minute and try again.', 'usage_limit', MANAGE_URLS.claude);
	}
	if (err instanceof Anthropic.BadRequestError) {
		if (/credit balance|billing/i.test(err.message)) {
			return new AiError('Your Claude API account is out of credit. Add credit in the Claude Console.', 'usage_limit', MANAGE_URLS.claude);
		}
		return new AiError(`Claude couldnâ€™t take this request: ${err.message}`, 'bad_request');
	}
	if (err instanceof Anthropic.APIConnectionError) return new AiError('Couldnâ€™t reach Claude. Check the internet connection.', 'network');
	if (err instanceof Anthropic.InternalServerError || (err instanceof Anthropic.APIError && (err.status ?? 0) >= 500)) {
		return new AiError('Claude is busy or unavailable right now. Try again shortly.', 'unavailable');
	}
	return new AiError(err instanceof Error ? err.message : String(err), 'unavailable');
}

// ------------------------------------------------- Claude plan (Claude Code)

/** Claude Code takes one prompt: earlier turns go in as a transcript before the latest message. */
function transcript(messages: AiMessage[]): string {
	if (messages.length === 1) return messages[0].content;
	const earlier = messages
		.slice(0, -1)
		.map((m) => `<${m.role}>\n${m.content}\n</${m.role}>`)
		.join('\n\n');
	return `Earlier in this conversation:\n\n${earlier}\n\nThe latest message, to answer now:\n\n${messages[messages.length - 1].content}`;
}

function claudeCodeFailure(err: unknown): never {
	if (!(err instanceof ClaudeCodeError)) throw err;
	const code: AiErrorCode =
		err.code === 'not_installed' ? 'not_connected' : err.code === 'auth' ? 'auth' : err.code === 'usage_limit' ? 'usage_limit' : err.code === 'refused' ? 'refused' : err.code === 'bad_output' ? 'bad_request' : 'unavailable';
	throw new AiError(err.message, code, code === 'usage_limit' ? MANAGE_URLS.claude_code : code === 'not_connected' || code === 'auth' ? '/settings/ai' : null);
}

async function claudeCodeComplete(req: AiRequest): Promise<AiResponse> {
	let out;
	try {
		out = await claudeCodeRun({ system: req.system, prompt: transcript(req.messages), schema: req.schema, effort: req.effort });
	} catch (err) {
		claudeCodeFailure(err);
	}
	const base = { provider: 'claude_code' as const, model: out.model, inputTokens: out.inputTokens, outputTokens: out.outputTokens };
	const costUsd = record(req, base);
	return { ...base, text: out.text, json: out.json, costUsd };
}

// ---------------------------------------------------------------- OpenAI

interface ResponsesOutputItem {
	type: string;
	content?: { type: string; text?: string; annotations?: { type: string; url?: string; title?: string; start_index?: number; end_index?: number }[] }[];
}

interface ResponsesEvent {
	type: string;
	delta?: string;
	response?: {
		usage?: { input_tokens?: number; output_tokens?: number };
		error?: { code?: string; message?: string };
		model?: string;
		incomplete_details?: { reason?: string };
		output?: ResponsesOutputItem[];
	};
	error?: { code?: string; message?: string };
	code?: string;
	message?: string;
}

async function* sseEvents<T = ResponsesEvent>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let buf = '';
	for (;;) {
		const { value, done } = await reader.read();
		if (done) break;
		buf += decoder.decode(value, { stream: true });
		let idx: number;
		while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
			const block = buf.slice(0, idx);
			buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
			const data = block
				.split(/\r?\n/)
				.filter((l) => l.startsWith('data:'))
				.map((l) => l.slice(5).trimStart())
				.join('\n');
			if (!data || data === '[DONE]') continue;
			try {
				yield JSON.parse(data) as T;
			} catch {
				// ignore keep-alives and partial lines
			}
		}
	}
}

/** Per account and model: features the ChatGPT plan route turned down, so they're left out next time. */
const unsupported = new Set<string>();

function openaiFailure(id: 'chatgpt' | 'openai', status: number, code: string, message: string): AiError {
	if (code === 'subscription_sharing_usage_limit_exceeded') {
		return new AiError('Youâ€™ve reached your ChatGPT planâ€™s usage limit for apps like Medicus Vitae. You can check or change it in ChatGPTâ€™s usage settings.', 'usage_limit', MANAGE_USAGE_URL);
	}
	if (code === 'subscription_sharing_user_not_eligible') {
		return new AiError('This ChatGPT account isnâ€™t eligible to use its plan in other apps. Use an API key instead.', 'auth', '/settings/ai');
	}
	if (code === 'subscription_sharing_usage_unavailable' || code === 'subscription_sharing_user_unavailable' || status === 503) {
		return new AiError('ChatGPT plan usage is temporarily unavailable. Try again in a little while.', 'unavailable');
	}
	if (status === 401 || code === 'subscription_sharing_invalid_user') {
		if (id === 'chatgpt') markSignedOut();
		return new AiError(id === 'chatgpt' ? 'Your ChatGPT sign-in is no longer valid. Sign in again under Settings â€º AI.' : 'OpenAI rejected the API key. Check it in Settings â€º AI.', 'auth', '/settings/ai');
	}
	if (status === 429) {
		return new AiError(
			/quota|billing/i.test(message) ? 'Your OpenAI API account is out of credit or over its limit.' : 'OpenAIâ€™s rate limit was reached. Wait a minute and try again.',
			'usage_limit',
			MANAGE_URLS.openai
		);
	}
	if (status === 403) return new AiError(`OpenAI refused the request: ${message || code}`, 'auth', '/settings/ai');
	return new AiError(`OpenAI couldnâ€™t take this request: ${message || code || status}`, 'bad_request');
}

async function openaiToken(id: 'chatgpt' | 'openai'): Promise<string> {
	if (id === 'chatgpt') {
		try {
			return await accessToken();
		} catch (err) {
			throw new AiError(err instanceof ChatgptError ? err.message : 'Sign in with ChatGPT again under Settings â€º AI.', 'auth', '/settings/ai');
		}
	}
	const key = keyFor('openai');
	if (!key) throw new AiError('Add an OpenAI API key in Settings â€º AI first.', 'not_connected', '/settings/ai');
	return key;
}

interface OpenaiRun {
	text: string;
	usage: { input: number; output: number };
	finalModel: string;
	output: ResponsesOutputItem[];
}

/** One Responses API call (streamed). Unsupported options come back as a retry hint. */
async function openaiCall(
	id: 'chatgpt' | 'openai',
	token: string,
	body: Record<string, unknown>
): Promise<OpenaiRun | { retry: 'schema' | 'reasoning' | 'tool' | null; error: AiError }> {
	let r: Response;
	try {
		r = await fetch('https://api.openai.com/v1/responses', {
			method: 'POST',
			headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'text/event-stream' },
			body: JSON.stringify({ ...body, store: false, stream: true })
		});
	} catch {
		throw new AiError('Couldnâ€™t reach OpenAI. Check the internet connection.', 'network');
	}
	if (!r.ok || !r.body) {
		const data = (await r.json().catch(() => ({}))) as { error?: { code?: string; message?: string; param?: string }; detail?: string };
		const code = data.error?.code ?? '';
		const param = data.error?.param ?? '';
		if (r.status === 400 && (code === 'subscription_sharing_unsupported_capability' || /unsupported|unknown/i.test(code) || /tools/.test(param))) {
			const retry = /text|format|schema/i.test(param) ? 'schema' : /reasoning/i.test(param) ? 'reasoning' : /tool/i.test(param) ? 'tool' : null;
			return { retry, error: openaiFailure(id, r.status, code, data.error?.message ?? '') };
		}
		throw openaiFailure(id, r.status, code, data.error?.message ?? data.detail ?? '');
	}
	let text = '';
	let usage = { input: 0, output: 0 };
	let finalModel = String(body.model ?? '');
	let output: ResponsesOutputItem[] = [];
	let completed = false;
	for await (const ev of sseEvents(r.body)) {
		if (ev.type === 'response.output_text.delta' && ev.delta) text += ev.delta;
		else if (ev.type === 'response.completed') {
			completed = true;
			usage = { input: ev.response?.usage?.input_tokens ?? 0, output: ev.response?.usage?.output_tokens ?? 0 };
			finalModel = ev.response?.model ?? finalModel;
			output = ev.response?.output ?? [];
		} else if (ev.type === 'response.failed' || ev.type === 'error') {
			const e = ev.response?.error ?? ev.error ?? { code: ev.code, message: ev.message };
			throw openaiFailure(id, e?.code?.includes('usage_limit') ? 429 : 400, e?.code ?? '', e?.message ?? '');
		} else if (ev.type === 'response.incomplete') {
			throw new AiError(`The answer stopped early (${ev.response?.incomplete_details?.reason ?? 'incomplete'}). Try again.`, 'truncated');
		}
	}
	if (!completed) throw new AiError('The connection to OpenAI ended before the answer finished. Try again.', 'network');
	return { text, usage, finalModel, output };
}

async function openaiComplete(id: 'chatgpt' | 'openai', req: AiRequest): Promise<AiResponse> {
	const token = await openaiToken(id);
	const model = modelFor(id);
	const tag = `${id}:${model}`;
	let useSchema = !!req.schema && !unsupported.has(`${tag}:schema`);
	let useReasoning = !unsupported.has(`${tag}:reasoning`);
	let out: Awaited<ReturnType<typeof openaiCall>> | null = null;
	for (let i = 0; i < 3; i++) {
		const body: Record<string, unknown> = {
			model,
			instructions: useSchema || !req.schema ? req.system : req.system + jsonInstruction(req.schema),
			input: req.messages.map((m) => ({ role: m.role, content: m.content }))
		};
		if (useSchema && req.schema) body.text = { format: { type: 'json_schema', name: 'answer', schema: req.schema, strict: true } };
		if (useReasoning) body.reasoning = { effort: req.effort ?? 'medium' };
		if (id === 'openai') body.max_output_tokens = req.maxTokens ?? 16000;
		out = await openaiCall(id, token, body);
		if ('retry' in out) {
			if (out.retry === 'schema' && useSchema) {
				unsupported.add(`${tag}:schema`);
				useSchema = false;
				continue;
			}
			if (out.retry === 'reasoning' && useReasoning) {
				unsupported.add(`${tag}:reasoning`);
				useReasoning = false;
				continue;
			}
			throw out.error;
		}
		break;
	}
	if (!out || 'retry' in out) throw new AiError('OpenAI couldnâ€™t take this request.', 'bad_request');
	const base = { provider: id, model: out.finalModel, inputTokens: out.usage.input, outputTokens: out.usage.output };
	const costUsd = record(req, base);
	return { ...base, text: out.text, json: req.schema ? parseJson(out.text) : null, costUsd };
}

// ---------------------------------------------------------------- Gemini

interface GeminiPart {
	text?: string;
	thought?: boolean;
}

interface GeminiResponse {
	candidates?: {
		content?: { parts?: GeminiPart[] };
		finishReason?: string;
		groundingMetadata?: {
			groundingChunks?: { web?: { uri?: string; title?: string } }[];
			groundingSupports?: { segment?: { startIndex?: number; endIndex?: number; text?: string }; groundingChunkIndices?: number[] }[];
			webSearchQueries?: string[];
		};
	}[];
	promptFeedback?: { blockReason?: string };
	usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
	modelVersion?: string;
	error?: { code?: number; message?: string; status?: string };
}

function geminiFailure(status: number, data: GeminiResponse): AiError {
	const msg = data.error?.message ?? '';
	const st = data.error?.status ?? '';
	if (status === 400 && /api key/i.test(msg)) return new AiError('Google rejected the Gemini API key. Check it in Settings â€º AI.', 'auth', '/settings/ai');
	if (status === 401 || status === 403 || st === 'PERMISSION_DENIED') return new AiError('Google rejected the Gemini API key (or it canâ€™t use this model). Check it in Settings â€º AI.', 'auth', '/settings/ai');
	if (status === 429 || st === 'RESOURCE_EXHAUSTED') return new AiError('Geminiâ€™s rate limit or free quota was reached. Wait a little, or check your plan in Google AI Studio.', 'usage_limit', MANAGE_URLS.gemini);
	if (status === 404) return new AiError(`Gemini doesnâ€™t have the model â€œ${modelFor('gemini')}â€. Pick another in Settings â€º AI.`, 'bad_request', '/settings/ai');
	if (status >= 500) return new AiError('Gemini is busy or unavailable right now. Try again shortly.', 'unavailable');
	return new AiError(`Gemini couldnâ€™t take this request: ${msg || st || status}`, 'bad_request');
}

const geminiNoJsonSchema = new Set<string>();

async function geminiCall(body: Record<string, unknown>): Promise<{ data: GeminiResponse; model: string }> {
	const key = keyFor('gemini');
	if (!key) throw new AiError('Add a Gemini API key in Settings â€º AI first.', 'not_connected', '/settings/ai');
	const model = modelFor('gemini').replace(/^models\//, '');
	let r: Response;
	try {
		r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(6 * 60_000)
		});
	} catch {
		throw new AiError('Couldnâ€™t reach Gemini. Check the internet connection.', 'network');
	}
	const data = (await r.json().catch(() => ({}))) as GeminiResponse;
	if (!r.ok) throw Object.assign(geminiFailure(r.status, data), { status: r.status, raw: data.error?.message ?? '' });
	return { data, model };
}

function geminiText(data: GeminiResponse): string {
	if (data.promptFeedback?.blockReason) throw new AiError(`Gemini declined this request (${data.promptFeedback.blockReason}).`, 'refused');
	const c = data.candidates?.[0];
	if (!c) throw new AiError('Gemini sent no answer. Try again.', 'unavailable');
	if (c.finishReason === 'SAFETY' || c.finishReason === 'PROHIBITED_CONTENT' || c.finishReason === 'BLOCKLIST') throw new AiError('Gemini declined to answer this request.', 'refused');
	return (c.content?.parts ?? []).filter((p) => !p.thought && typeof p.text === 'string').map((p) => p.text).join('');
}

const contents = (messages: AiMessage[]) => messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));

async function geminiComplete(req: AiRequest): Promise<AiResponse> {
	const model = modelFor('gemini');
	const nativeSchema = !!req.schema && !geminiNoJsonSchema.has(model);
	const body = (useSchema: boolean): Record<string, unknown> => ({
		systemInstruction: { parts: [{ text: useSchema || !req.schema ? req.system : req.system + jsonInstruction(req.schema) }] },
		contents: contents(req.messages),
		generationConfig: {
			maxOutputTokens: req.maxTokens ?? 16000,
			...(req.schema ? { responseMimeType: 'application/json' } : {}),
			...(useSchema && req.schema ? { responseJsonSchema: req.schema } : {})
		}
	});
	let res: { data: GeminiResponse; model: string };
	try {
		res = await geminiCall(body(nativeSchema));
	} catch (err) {
		// Older models only take Google's own schema dialect: ask for the JSON in words instead.
		if (nativeSchema && err instanceof AiError && err.code === 'bad_request' && /schema/i.test(String((err as AiError & { raw?: string }).raw ?? err.message))) {
			geminiNoJsonSchema.add(model);
			res = await geminiCall(body(false));
		} else throw err;
	}
	const text = geminiText(res.data);
	if (res.data.candidates?.[0]?.finishReason === 'MAX_TOKENS' && req.schema) throw new AiError('The answer was cut off before it finished. Try a shorter request.', 'truncated');
	const u = res.data.usageMetadata ?? {};
	const base = { provider: 'gemini' as const, model: res.data.modelVersion || res.model, inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
	const costUsd = record(req, base);
	return { ...base, text, json: req.schema ? parseJson(text) : null, costUsd };
}

// ------------------------------------------- OpenRouter and OpenAI-compatible

interface ChatCompletion {
	choices?: {
		message?: {
			content?: string | null;
			annotations?: { type?: string; url_citation?: { url?: string; title?: string; content?: string; start_index?: number; end_index?: number }; url?: string; title?: string }[];
		};
		finish_reason?: string;
	}[];
	usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
	model?: string;
	error?: { message?: string; code?: number | string };
}

function chatFailure(id: 'openrouter' | 'custom', status: number, data: ChatCompletion): AiError {
	const msg = String(data.error?.message ?? '');
	const name = id === 'openrouter' ? 'OpenRouter' : 'The service';
	if (status === 401 || status === 403) return new AiError(`${name} rejected the API key. Check it in Settings â€º AI.`, 'auth', '/settings/ai');
	if (status === 402) return new AiError('Your OpenRouter credit has run out. Add credit, or pick a free model (its name ends in â€œ:freeâ€).', 'usage_limit', MANAGE_URLS.openrouter);
	if (status === 429) return new AiError(`${name}â€™s rate limit was reached. Wait a minute and try again.`, 'usage_limit', id === 'openrouter' ? MANAGE_URLS.openrouter : null);
	if (status === 404) return new AiError(`${name} doesnâ€™t have the model â€œ${modelFor(id)}â€. Pick another in Settings â€º AI.`, 'bad_request', '/settings/ai');
	if (status >= 500) return new AiError(`${name} is busy or unavailable right now. Try again shortly.`, 'unavailable');
	return new AiError(`${name} couldnâ€™t take this request: ${msg || status}`, 'bad_request');
}

const chatNoSchema = new Set<string>();

async function chatCall(id: 'openrouter' | 'custom', body: Record<string, unknown>): Promise<{ data: ChatCompletion; status: number }> {
	const base = id === 'openrouter' ? 'https://openrouter.ai/api/v1' : customBaseUrl();
	if (!base) throw new AiError('Enter the serviceâ€™s address in Settings â€º AI first.', 'not_connected', '/settings/ai');
	const key = keyFor(id);
	if (id === 'openrouter' && !key) throw new AiError('Add an OpenRouter API key in Settings â€º AI first.', 'not_connected', '/settings/ai');
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (key) headers.authorization = `Bearer ${key}`;
	if (id === 'openrouter') {
		headers['x-title'] = 'Medicus Vitae';
		headers['http-referer'] = 'https://github.com/medicus-vitae';
	}
	let r: Response;
	try {
		r = await fetch(`${base}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(6 * 60_000) });
	} catch {
		throw new AiError(id === 'openrouter' ? 'Couldnâ€™t reach OpenRouter. Check the internet connection.' : `Couldnâ€™t reach the service at ${base}. Is it running?`, 'network');
	}
	const data = (await r.json().catch(() => ({}))) as ChatCompletion;
	return { data, status: r.status };
}

async function chatComplete(id: 'openrouter' | 'custom', req: AiRequest): Promise<AiResponse> {
	const model = modelFor(id);
	if (!model) throw new AiError('Choose a model in Settings â€º AI first.', 'not_connected', '/settings/ai');
	const tag = `${id}:${model}`;
	let useSchema = !!req.schema && !chatNoSchema.has(tag);
	let res: { data: ChatCompletion; status: number } | null = null;
	for (let i = 0; i < 2; i++) {
		const system = useSchema || !req.schema ? req.system : req.system + jsonInstruction(req.schema);
		const body: Record<string, unknown> = {
			model,
			messages: [{ role: 'system', content: system }, ...req.messages.map((m) => ({ role: m.role, content: m.content }))],
			max_tokens: req.maxTokens ?? 16000
		};
		if (useSchema && req.schema) body.response_format = { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema: req.schema } };
		if (id === 'openrouter') body.usage = { include: true };
		res = await chatCall(id, body);
		if (res.status === 400 && useSchema && /response_format|json_schema|structured/i.test(String(res.data.error?.message ?? ''))) {
			chatNoSchema.add(tag);
			useSchema = false;
			continue;
		}
		break;
	}
	if (!res || res.status >= 400 || res.data.error) throw chatFailure(id, res?.status ?? 500, res?.data ?? {});
	const choice = res.data.choices?.[0];
	const text = String(choice?.message?.content ?? '');
	if (!text.trim()) throw new AiError('The service sent an empty answer. Try again, or pick another model.', 'unavailable');
	if (choice?.finish_reason === 'length' && req.schema) throw new AiError('The answer was cut off before it finished. Try a shorter request.', 'truncated');
	const base = { provider: id, model: res.data.model || model, inputTokens: res.data.usage?.prompt_tokens ?? 0, outputTokens: res.data.usage?.completion_tokens ?? 0 };
	// OpenRouter reports what the request cost; a local service costs nothing unless prices are set.
	const reported = typeof res.data.usage?.cost === 'number' ? res.data.usage.cost : undefined;
	const costUsd = record(req, base, reported !== undefined ? { costUsd: reported } : {});
	return { ...base, text, json: req.schema ? parseJson(text) : null, costUsd };
}

// ----------------------------------------------------------- web research

export interface WebSource {
	n: number;
	url: string;
	title: string;
	/** What the answer relied on from this page, when the service says. */
	quote: string;
}

export interface ResearchRequest {
	system: string;
	messages: AiMessage[];
	/** Most searches one answer may run. */
	maxSearches?: number;
	maxTokens?: number;
}

export interface ResearchResponse {
	/** Markdown with [n] markers that match `sources`. */
	text: string;
	sources: WebSource[];
	provider: ProviderId;
	model: string;
	searches: number;
	costUsd: number | null;
}

/** Numbers sources by first appearance and turns cited spans into [n] markers. */
class SourceList {
	list: WebSource[] = [];
	n(url: string, title = '', quote = ''): number {
		const clean = url.trim();
		let s = this.list.find((x) => x.url === clean);
		if (!s) {
			s = { n: this.list.length + 1, url: clean, title: title.trim() || hostLabel(clean), quote: '' };
			this.list.push(s);
		}
		if (quote && s.quote.length < 600) s.quote = (s.quote ? `${s.quote} â€¦ ` : '') + quote.trim().slice(0, 400);
		return s.n;
	}
}

function hostLabel(url: string) {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return url.slice(0, 80);
	}
}

const markers = (ns: number[]) => [...new Set(ns)].sort((a, b) => a - b).map((n) => `[${n}]`).join('');

/** Puts markers into text at character positions (end of each cited span). */
function insertMarkers(text: string, spots: { at: number; n: number }[]): string {
	const byAt = new Map<number, number[]>();
	for (const s of spots) {
		const at = Math.max(0, Math.min(text.length, s.at));
		(byAt.get(at) ?? byAt.set(at, []).get(at)!).push(s.n);
	}
	let out = text;
	for (const at of [...byAt.keys()].sort((a, b) => b - a)) out = out.slice(0, at) + markers(byAt.get(at)!) + out.slice(at);
	return out;
}

async function claudeResearch(req: ResearchRequest): Promise<ResearchResponse> {
	const client = claudeClient();
	const model = modelFor('claude');
	const messages: Anthropic.Beta.BetaMessageParam[] = req.messages.map((m) => ({ role: m.role, content: m.content }));
	const params = {
		model,
		max_tokens: req.maxTokens ?? 12000,
		system: req.system,
		tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: req.maxSearches ?? 5 }] as Anthropic.Beta.BetaToolUnion[],
		output_config: { effort: 'medium' as const }
	};
	const sources = new SourceList();
	let text = '';
	let searches = 0;
	let inputTokens = 0;
	let outputTokens = 0;
	let finalModel = model;
	// A long server-tool turn can pause: send it back and the server carries on.
	for (let i = 0; i < 4; i++) {
		const message = await claudeStream(client, { ...params, messages });
		const u = claudeUsage(message);
		inputTokens += u.inputTokens;
		outputTokens += u.outputTokens;
		searches += message.usage.server_tool_use?.web_search_requests ?? 0;
		finalModel = message.model || model;
		if (message.stop_reason === 'refusal') throw new AiError('Claude declined to answer this request.', 'refused');
		for (const b of message.content) {
			if (b.type !== 'text') continue;
			const cited = (b.citations ?? [])
				.filter((c) => c.type === 'web_search_result_location')
				.map((c) => {
					const w = c as { url: string; title?: string | null; cited_text?: string };
					return sources.n(w.url, w.title ?? '', w.cited_text ?? '');
				});
			text += b.text + (cited.length ? markers(cited) : '');
		}
		if (message.stop_reason !== 'pause_turn') break;
		messages.push({ role: 'assistant', content: message.content as Anthropic.Beta.BetaContentBlockParam[] });
	}
	const base = { provider: 'claude' as const, model: finalModel, inputTokens, outputTokens };
	const costUsd = record({ feature: 'research' }, base, { searches });
	return { text: text.trim(), sources: sources.list, provider: 'claude', model: finalModel, searches, costUsd };
}

const RESEARCH_SCHEMA = {
	type: 'object',
	properties: {
		answer: { type: 'string' },
		sources: {
			type: 'array',
			items: {
				type: 'object',
				properties: { n: { type: 'integer' }, url: { type: 'string' }, title: { type: 'string' }, quote: { type: 'string' } },
				required: ['n', 'url', 'title', 'quote'],
				additionalProperties: false
			}
		}
	},
	required: ['answer', 'sources'],
	additionalProperties: false
} as const;

async function claudeCodeResearch(req: ResearchRequest): Promise<ResearchResponse> {
	let out;
	try {
		out = await claudeCodeRun({
			system: `${req.system}\n\nUse WebSearch (and WebFetch to read a page) to find sources. Reply in the JSON format: "answer" in Markdown with [n] markers, and "sources" listing every [n] with its url, page title and the sentence you relied on.`,
			prompt: transcript(req.messages),
			schema: RESEARCH_SCHEMA as unknown as Record<string, unknown>,
			effort: 'medium',
			webTools: true,
			timeoutMs: 8 * 60_000
		});
	} catch (err) {
		claudeCodeFailure(err);
	}
	const j = (out.json ?? {}) as { answer?: string; sources?: { n: number; url: string; title: string; quote: string }[] };
	const sources = (j.sources ?? []).filter((s) => /^https?:\/\//.test(String(s.url ?? ''))).map((s) => ({ n: Number(s.n), url: String(s.url), title: String(s.title ?? '') || hostLabel(String(s.url)), quote: String(s.quote ?? '').slice(0, 600) }));
	const base = { provider: 'claude_code' as const, model: out.model, inputTokens: out.inputTokens, outputTokens: out.outputTokens };
	const costUsd = record({ feature: 'research' }, base);
	return { text: String(j.answer ?? out.text ?? '').trim(), sources, provider: 'claude_code', model: out.model, searches: 0, costUsd };
}

async function openaiResearch(id: 'chatgpt' | 'openai', req: ResearchRequest): Promise<ResearchResponse> {
	const token = await openaiToken(id);
	const model = modelFor(id);
	let toolType = 'web_search';
	let run: Awaited<ReturnType<typeof openaiCall>> | null = null;
	for (let i = 0; i < 2; i++) {
		const body: Record<string, unknown> = {
			model,
			instructions: req.system,
			input: req.messages.map((m) => ({ role: m.role, content: m.content })),
			tools: [{ type: toolType }],
			reasoning: { effort: 'medium' }
		};
		if (id === 'openai') body.max_output_tokens = req.maxTokens ?? 12000;
		run = await openaiCall(id, token, body);
		if ('retry' in run) {
			if (toolType === 'web_search') {
				toolType = 'web_search_preview';
				continue;
			}
			throw new AiError(id === 'chatgpt' ? 'Your ChatGPT plan connection canâ€™t search the web from apps. Use Claude Code, an API key or OpenRouter for Research.' : `OpenAI couldnâ€™t search the web: ${run.error.message}`, 'bad_request', '/settings/ai');
		}
		break;
	}
	if (!run || 'retry' in run) throw new AiError('OpenAI couldnâ€™t search the web.', 'bad_request');
	const sources = new SourceList();
	let text = '';
	let searches = 0;
	for (const item of run.output) {
		if (item.type === 'web_search_call') searches++;
		if (item.type !== 'message') continue;
		for (const c of item.content ?? []) {
			if (c.type !== 'output_text' || !c.text) continue;
			const spots = (c.annotations ?? []).filter((a) => a.type === 'url_citation' && a.url).map((a) => ({ at: a.end_index ?? c.text!.length, n: sources.n(a.url!, a.title ?? '') }));
			// OpenAI puts a link in the text too; the marker replaces it.
			const withMarkers = insertMarkers(c.text, spots);
			text += withMarkers.replace(/\s*\(\[[^\]]*\]\(https?:[^)]+\)\)/g, '');
		}
	}
	if (!text) text = run.text;
	const base = { provider: id, model: run.finalModel, inputTokens: run.usage.input, outputTokens: run.usage.output };
	const costUsd = record({ feature: 'research' }, base, { searches });
	return { text: text.trim(), sources: sources.list, provider: id, model: run.finalModel, searches, costUsd };
}

/** Gemini counts segment positions in UTF-8 bytes. */
function byteToCharIndex(text: string, byte: number): number {
	const enc = new TextEncoder();
	let bytes = 0;
	let i = 0;
	for (const ch of text) {
		if (bytes >= byte) return i;
		bytes += enc.encode(ch).length;
		i += ch.length;
	}
	return text.length;
}

async function geminiResearch(req: ResearchRequest): Promise<ResearchResponse> {
	const res = await geminiCall({
		systemInstruction: { parts: [{ text: req.system }] },
		contents: contents(req.messages),
		tools: [{ google_search: {} }],
		generationConfig: { maxOutputTokens: req.maxTokens ?? 12000 }
	});
	const text = geminiText(res.data);
	const meta = res.data.candidates?.[0]?.groundingMetadata;
	const chunks = meta?.groundingChunks ?? [];
	const sources = new SourceList();
	const spots: { at: number; n: number }[] = [];
	for (const s of meta?.groundingSupports ?? []) {
		const end = byteToCharIndex(text, s.segment?.endIndex ?? 0);
		for (const ci of s.groundingChunkIndices ?? []) {
			const web = chunks[ci]?.web;
			if (web?.uri) spots.push({ at: end, n: sources.n(web.uri, web.title ?? '', s.segment?.text ?? '') });
		}
	}
	const u = res.data.usageMetadata ?? {};
	const base = { provider: 'gemini' as const, model: res.data.modelVersion || res.model, inputTokens: u.promptTokenCount ?? 0, outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
	const costUsd = record({ feature: 'research' }, base);
	return { text: insertMarkers(text, spots).trim(), sources: sources.list, provider: 'gemini', model: base.model, searches: meta?.webSearchQueries?.length ?? 0, costUsd };
}

async function openrouterResearch(req: ResearchRequest): Promise<ResearchResponse> {
	const model = modelFor('openrouter');
	const messages = [{ role: 'system', content: req.system }, ...req.messages.map((m) => ({ role: m.role, content: m.content }))];
	// The web search server tool; models that don't take it get the older web plugin.
	let res = await chatCall('openrouter', { model, messages, max_tokens: req.maxTokens ?? 12000, usage: { include: true }, tools: [{ type: 'openrouter:web_search', parameters: { max_results: req.maxSearches ?? 5 } }] });
	if (res.status === 400) res = await chatCall('openrouter', { model, messages, max_tokens: req.maxTokens ?? 12000, usage: { include: true }, plugins: [{ id: 'web', max_results: req.maxSearches ?? 5 }] });
	if (res.status >= 400 || res.data.error) throw chatFailure('openrouter', res.status, res.data);
	const msg = res.data.choices?.[0]?.message;
	const text = String(msg?.content ?? '');
	const sources = new SourceList();
	const spots: { at: number; n: number }[] = [];
	const loose: number[] = [];
	for (const a of msg?.annotations ?? []) {
		const c = a.url_citation ?? { url: a.url, title: a.title };
		if (!c?.url) continue;
		const n = sources.n(c.url, c.title ?? '', (c as { content?: string }).content ?? '');
		const end = (c as { end_index?: number }).end_index;
		if (typeof end === 'number') spots.push({ at: end, n });
		else loose.push(n);
	}
	let out = insertMarkers(text, spots);
	if (loose.length && !spots.length) out += `\n\n${markers(loose)}`;
	const base = { provider: 'openrouter' as const, model: res.data.model || model, inputTokens: res.data.usage?.prompt_tokens ?? 0, outputTokens: res.data.usage?.completion_tokens ?? 0 };
	const costUsd = record({ feature: 'research' }, base, typeof res.data.usage?.cost === 'number' ? { costUsd: res.data.usage.cost } : {});
	return { text: out.trim(), sources: sources.list, provider: 'openrouter', model: base.model, searches: 0, costUsd };
}

/** Answers with sources found on the web, through the connection in use (each service's own search). */
export async function research(req: ResearchRequest, provider: ProviderId | null = activeProviderId()): Promise<ResearchResponse> {
	if (researchOverride) return researchOverride(req);
	if (!provider) throw new AiError('Connect an AI service in Settings â€º AI to use Research.', 'not_connected', '/settings/ai');
	checkCap(provider);
	if (provider === 'claude') return claudeResearch(req);
	if (provider === 'claude_code') return claudeCodeResearch(req);
	if (provider === 'chatgpt' || provider === 'openai') return openaiResearch(provider, req);
	if (provider === 'gemini') return geminiResearch(req);
	if (provider === 'openrouter') return openrouterResearch(req);
	throw new AiError('The connection in use canâ€™t search the web. Switch to Claude, ChatGPT/OpenAI, Gemini or OpenRouter in Settings â€º AI for Research.', 'bad_request', '/settings/ai');
}

/** Model names a connection offers, for the picker in Settings (best effort; empty when it can't say). */
export async function listModels(id: KeyProviderId): Promise<{ id: string; name: string }[]> {
	try {
		if (id === 'gemini') {
			const key = keyFor('gemini');
			if (!key) return [];
			const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key }, signal: AbortSignal.timeout(15_000) });
			const d = (await r.json()) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
			return (d.models ?? [])
				.filter((m) => m.supportedGenerationMethods?.includes('generateContent') && /gemini/i.test(m.name))
				.map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName ?? m.name }));
		}
		if (id === 'openrouter') {
			const r = await fetch('https://openrouter.ai/api/v1/models', { signal: AbortSignal.timeout(15_000) });
			const d = (await r.json()) as { data?: { id: string; name?: string }[] };
			return (d.data ?? []).map((m) => ({ id: m.id, name: m.name ?? m.id }));
		}
		if (id === 'custom') {
			const base = customBaseUrl();
			if (!base) return [];
			const key = keyFor('custom');
			const r = await fetch(`${base}/models`, { headers: key ? { authorization: `Bearer ${key}` } : {}, signal: AbortSignal.timeout(10_000) });
			const d = (await r.json()) as { data?: { id: string }[] };
			return (d.data ?? []).map((m) => ({ id: m.id, name: m.id }));
		}
	} catch {
		return [];
	}
	return [];
}

// ------------------------------------------------------------------- entry

/** Test hook: replaces the real providers (unit tests). */
let override: ((req: AiRequest) => Promise<AiResponse>) | null = null;
let researchOverride: ((req: ResearchRequest) => Promise<ResearchResponse>) | null = null;
export function setProviderOverride(fn: typeof override, researchFn: typeof researchOverride = null) {
	override = fn;
	researchOverride = researchFn;
}

/** Browser tests only (CORTEX_FAKE_AI=1): a stand-in service that counts as connected. */
let testMode = false;
export function enableTestAi(fn: (req: AiRequest) => Promise<AiResponse>, researchFn: typeof researchOverride = null) {
	testMode = true;
	override = fn;
	researchOverride = researchFn;
}

export async function complete(req: AiRequest, provider: ProviderId | null = activeProviderId()): Promise<AiResponse> {
	if (override) return override(req);
	if (!provider) throw new AiError('Connect an AI service in Settings â€º AI to use the tutor.', 'not_connected', '/settings/ai');
	checkCap(provider);
	if (provider === 'claude_code') return claudeCodeComplete(req);
	if (provider === 'claude') return claudeComplete(req);
	if (provider === 'gemini') return geminiComplete(req);
	if (provider === 'openrouter' || provider === 'custom') return chatComplete(provider, req);
	return openaiComplete(provider, req);
}
