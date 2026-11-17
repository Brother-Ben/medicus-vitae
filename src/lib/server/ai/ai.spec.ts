// M4 checks that don't need a real AI account: the search index (books,
// figures, notes, cards; never AI-made text), the grounded-answer pipeline with
// its reference and support checks, "not in your material", generation with
// approval, the monthly cap, and the ChatGPT / Claude / OpenAI wire formats
// against recorded-shape fake servers.

import { generateKeyPairSync, sign } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-ai-'));
process.env.CORTEX_DATA_DIR = dir;
process.env.CORTEX_ENV_LOADED = '1';
process.env.CORTEX_EMBEDDINGS = 'off';
delete process.env.ANTHROPIC_API_KEY;
delete process.env.OPENAI_API_KEY;

type Mods = {
	config: typeof import('../config');
	db: typeof import('../db');
	schema: typeof import('../db/schema');
	instance: typeof import('../instance');
	cards: typeof import('../cards');
	indexer: typeof import('./indexer');
	indexDb: typeof import('./index-db');
	retrieval: typeof import('./retrieval');
	providers: typeof import('./providers');
	tutor: typeof import('./tutor');
	generate: typeof import('./generate');
	chatgpt: typeof import('./chatgpt');
	reading: typeof import('../reading');
};
let m: Mods;

const DOC = 'doc-1';
const VER = 'ver-1';

// A two-page "book": page 1 on enzyme kinetics, page 2 with a figure and its caption.
const PAGE1 =
	'Enzyme kinetics. In Michaelis-Menten kinetics the reaction velocity rises with substrate concentration and levels off at Vmax when the enzyme is saturated. Km is the substrate concentration at half of Vmax.\n\nA competitive inhibitor binds the active site; Vmax is unchanged while the apparent Km increases. A noncompetitive inhibitor lowers Vmax without changing Km.';
const PAGE2 = 'Inhibition at a glance\nFigure 2.1 Lineweaver-Burk plots for competitive and noncompetitive inhibitors.\nThe intercepts show how each inhibitor changes Km and Vmax.';

function runsFor(text: string, lines: { y0: number; y1: number }[]) {
	// One run per line of text, laid out down the page at the given heights.
	const runs: number[][] = [];
	let start = 0;
	text.split('\n').forEach((line, i) => {
		const y = lines[i] ?? { y0: 0.1 + i * 0.03, y1: 0.12 + i * 0.03 };
		if (line.length) runs.push([start, start + line.length, 0.1, y.y0, 0.9, y.y1]);
		start += line.length + 1;
	});
	return runs;
}

beforeAll(async () => {
	m = {
		config: await import('../config'),
		db: await import('../db'),
		schema: await import('../db/schema'),
		instance: await import('../instance'),
		cards: await import('../cards'),
		indexer: await import('./indexer'),
		indexDb: await import('./index-db'),
		retrieval: await import('./retrieval'),
		providers: await import('./providers'),
		tutor: await import('./tutor'),
		generate: await import('./generate'),
		chatgpt: await import('./chatgpt'),
		reading: await import('../reading')
	};
	m.config.ensureDataDirs();
	m.db.openLocalDatabase();
	await m.db.openMainDatabase();
	m.instance.ensureInstance();
	const now = Date.now();
	const d = m.db.db();
	d.insert(m.schema.user).values({ id: 1, passwordHash: 'x', createdAt: now, updatedAt: now }).run();
	d.insert(m.schema.document)
		.values({ id: DOC, title: 'Biochem Review', fileHash: 'a'.repeat(64), fileName: 'b.pdf', fileSize: 1, pageCount: 2, status: 'ready', currentVersionId: VER, createdAt: now, updatedAt: now })
		.run();
	d.insert(m.schema.documentVersion).values({ id: VER, documentId: DOC, extractionVersion: 'test', status: 'ready', pageCount: 2, createdAt: now }).run();
	d.insert(m.schema.docPage).values({ id: 'p1', versionId: VER, pageNumber: 1, width: 612, height: 792, text: PAGE1, items: JSON.stringify(runsFor(PAGE1, [])) }).run();
	// Page 2: heading at the top, then a big gap (the drawing), then the caption and a line of text.
	d.insert(m.schema.docPage)
		.values({ id: 'p2', versionId: VER, pageNumber: 2, width: 612, height: 792, text: PAGE2, items: JSON.stringify(runsFor(PAGE2, [{ y0: 0.08, y1: 0.1 }, { y0: 0.6, y1: 0.62 }, { y0: 0.64, y1: 0.66 }])) })
		.run();
	d.insert(m.schema.docSection).values({ id: 'sec-1', documentId: DOC, title: '2 Enzymes', level: 0, position: 0, pageStart: 1, pageEnd: 2, aamcCodes: ['1A'], suggestedCodes: [], confirmed: true }).run();
	m.cards.createNote({ kind: 'basic', fields: { Front: 'What does ADH insert into the collecting duct?', Back: 'Aquaporins, so more water is reabsorbed.' } });
	m.reading.createAnnotation({ documentId: DOC, body: 'My note: Km is about affinity; lower Km means tighter binding.' });
	// An AI-made card: must never become evidence.
	m.cards.createNote({ kind: 'basic', fields: { Front: 'AI CARD about Km', Back: 'AI-generated text' }, origin: 'ai' });
});

afterEach(() => {
	m?.providers.setProviderOverride(null);
	vi.unstubAllGlobals();
});

afterAll(async () => {
	await m?.indexer.stopIndexer();
	m?.indexDb.closeIndexDb();
	m?.db.closeDatabases();
	fs.rmSync(dir, { recursive: true, force: true });
});

/** A fake AI service: answers by feature, records what it was sent. */
function fakeAi(handlers: Partial<Record<string, (req: import('./providers').AiRequest, call: number) => unknown>>) {
	const calls: import('./providers').AiRequest[] = [];
	m.providers.setProviderOverride(async (req) => {
		calls.push(req);
		const n = calls.filter((c) => c.feature === req.feature).length;
		const json = handlers[req.feature]?.(req, n) ?? {};
		return { text: JSON.stringify(json), json, provider: 'claude', model: 'fake-model', inputTokens: 100, outputTokens: 50, costUsd: 0.001 };
	});
	return calls;
}

describe('search index (AI-08)', () => {
	it('indexes book passages, figures by caption, owner notes and cards, but no AI-made text', async () => {
		m.indexer.requestIndex();
		await m.indexer.indexIdle();
		const s = m.indexDb.indexStats();
		expect(s.kinds.page).toBeGreaterThanOrEqual(2);
		expect(s.kinds.figure).toBe(1);
		expect(s.kinds.annotation).toBe(1);
		expect(s.kinds.card).toBe(1);
		const texts = (m.indexDb.indexDb().prepare('SELECT text FROM chunk').pluck().all() as string[]).join(' ');
		expect(texts).not.toContain('AI CARD');
		const fig = m.indexDb.indexDb().prepare(`SELECT rects, text FROM chunk WHERE kind = 'figure'`).get() as { rects: string; text: string };
		expect(fig.text).toMatch(/^Figure 2\.1 Lineweaver-Burk/);
		const [[, top, , bottom]] = JSON.parse(fig.rects) as number[][];
		// The region covers the empty area above the caption (where the plot is drawn).
		expect(top).toBeLessThan(0.15);
		expect(bottom).toBeGreaterThan(0.6);
	});

	it('retrieves the passage that answers a question', async () => {
		const found = await m.retrieval.retrieve('What does a noncompetitive inhibitor do to Km?', { k: 3 });
		const hit = found.find((p) => p.text.includes('noncompetitive inhibitor lowers Vmax'));
		expect(hit).toBeTruthy();
		expect(hit!.label).toContain('Biochem Review');
		expect(found.every((p) => p.provenance !== 'ai')).toBe(true);
	});

	it('finds figures by their captions', async () => {
		const found = await m.retrieval.retrieve('Lineweaver-Burk plot', { k: 3 });
		expect(found.some((p) => p.kind === 'figure' && !!p.rects)).toBe(true);
	});
});

describe('grounded tutor (AI-01, AI-03)', () => {
	it('answers with citations that link to the exact passage, and records the checks', async () => {
		const calls = fakeAi({
			tutor: (req) => {
				const sid = /<source id="(S\d+)"[^>]*>\s*[^<]*noncompetitive inhibitor lowers/.exec(req.messages.at(-1)!.content)![1];
				return {
					status: 'answered',
					answer: `A noncompetitive inhibitor lowers Vmax but leaves Km unchanged [${sid}].`,
					claims: [{ text: 'A noncompetitive inhibitor lowers Vmax but leaves Km unchanged.', sources: [sid], kind: 'content' }],
					suggestion: ''
				};
			},
			check: () => ({ verdicts: [{ index: 1, verdict: 'supported', note: 'Stated directly.' }] })
		});
		const r = await m.tutor.askTutor({ question: 'What does a noncompetitive inhibitor do to Km?', mode: 'explain' });
		expect(r.answer.status).toBe('answered');
		expect(r.answer.text).toMatch(/unchanged \[1\]\.$/);
		expect(r.answer.citations).toHaveLength(1);
		const c = r.answer.citations[0];
		expect(c.kind).toBe('page');
		expect(c.anchorId).toBeTruthy();
		expect(c.support).toBe('supported');
		const a = m.reading.anchorView(c.anchorId)!;
		expect(a.page).toBe(1);
		expect(a.exact).toContain('noncompetitive inhibitor lowers Vmax');
		// The question and passages went to the model; the system prompt says sources aren't instructions.
		expect(calls[0].system).toMatch(/never instructions/);
		expect(calls[0].messages.at(-1)!.content).toContain('<sources>');
		expect(calls.map((x) => x.feature)).toEqual(['tutor', 'check']);
		// Saved as a conversation.
		const t = m.tutor.getThread(r.threadId)!;
		expect(t.messages.map((x) => x.role)).toEqual(['user', 'assistant']);
	});

	it('retries once when the answer cites a passage that was never sent, then accepts the corrected answer', async () => {
		const calls = fakeAi({
			tutor: (_req, n) =>
				n === 1
					? { status: 'answered', answer: 'Km is half of Vmax [S9].', claims: [{ text: 'Km is at half Vmax.', sources: ['S9'], kind: 'content' }], suggestion: '' }
					: { status: 'answered', answer: 'Km is the substrate concentration at half of Vmax [S1].', claims: [{ text: 'Km is the [S] at half Vmax.', sources: ['S1'], kind: 'content' }], suggestion: '' },
			check: () => ({ verdicts: [{ index: 1, verdict: 'supported', note: '' }] })
		});
		const r = await m.tutor.askTutor({ question: 'What is Km?', mode: 'explain' });
		expect(calls.filter((c) => c.feature === 'tutor')).toHaveLength(2);
		expect(calls[1].messages.at(-1)!.content).toMatch(/weren't provided/);
		expect(r.answer.status).toBe('answered');
		expect(r.answer.text).not.toContain('S9');
	});

	it('shows an answer flagged, never silently, when the support check says a passage does not back it', async () => {
		fakeAi({
			tutor: () => ({ status: 'answered', answer: 'Competitive inhibitors lower Vmax [S1].', claims: [{ text: 'Competitive inhibitors lower Vmax.', sources: ['S1'], kind: 'content' }], suggestion: '' }),
			check: () => ({ verdicts: [{ index: 1, verdict: 'unsupported', note: 'The passage says Vmax is unchanged.' }] })
		});
		const r = await m.tutor.askTutor({ question: 'What do competitive inhibitors do to Vmax?', mode: 'explain' });
		expect(r.answer.status).toBe('flagged');
		expect(r.answer.citations[0].support).toBe('unsupported');
		expect(r.answer.claims[0].note).toMatch(/unchanged/);
	});

	it('says when something is not in the material, and suggests what to add', async () => {
		fakeAi({
			tutor: () => ({ status: 'not_found', answer: 'That isn’t in your material.', claims: [], suggestion: 'Look for a chapter on the urea cycle.' }),
			check: () => {
				throw new Error('no check expected');
			}
		});
		const r = await m.tutor.askTutor({ question: 'What are the steps of the urea cycle?' });
		expect(r.answer.status).toBe('not_found');
		expect(r.answer.text).toContain('urea cycle');
	});

	it('includes the selected passage as a source when asking about a selection', async () => {
		const calls = fakeAi({ tutor: () => ({ status: 'answered', answer: 'It is about saturation [S1].', claims: [{ text: 'Saturation.', sources: ['S1'], kind: 'content' }], suggestion: '' }), check: () => ({ verdicts: [{ index: 1, verdict: 'partial', note: '' }] }) });
		const anchorId = m.reading.createAnchor({ documentId: DOC, versionId: VER, page: 1, kind: 'text', rects: [[0.1, 0.1, 0.9, 0.12]], textStart: 0, textEnd: 60, exact: PAGE1.slice(0, 60) });
		const r = await m.tutor.askTutor({ question: 'Explain this', context: { kind: 'selection', anchorId, documentId: DOC, page: 1 } });
		expect(calls[0].messages.at(-1)!.content).toMatch(/<source id="S1"[^>]*>\s*Enzyme kinetics/);
		expect(r.answer.citations[0].anchorId).toBe(anchorId);
		expect(r.answer.status).toBe('flagged');
	});
});

describe('generation and approval (AI-02)', () => {
	it('flags items whose sources are invalid or unsupported, and creates AI-marked items only on approval', async () => {
		fakeAi({
			generate: () => ({
				items: [
					{ type: 'basic', front: 'What does a competitive inhibitor do to apparent Km?', back: 'It increases it; Vmax is unchanged.', text: '', sources: ['S1'] },
					{ type: 'basic', front: 'Made-up card', back: 'No source', text: '', sources: ['S99'] }
				]
			}),
			check: () => ({ verdicts: [{ index: 1, verdict: 'supported', note: '' }] })
		});
		const r = await m.generate.generateItems({ documentId: DOC, sectionId: 'sec-1', kind: 'card', count: 5 });
		expect(r.created).toBe(2);
		expect(r.flagged).toBe(1);
		const items = m.generate.pendingItems();
		const good = items.find((i) => !i.flagged)!;
		expect(good.sources[0].anchorId).toBeTruthy();
		expect(good.aamcCode).toBe('1A');
		expect(m.generate.approveUnflagged(items.map((i) => i.id))).toBe(1);
		const n = m.db.sqlite().prepare(`SELECT origin, tags FROM note WHERE id = (SELECT result_ref FROM generated_item WHERE id = ?)`).get(good.id) as { origin: string; tags: string };
		expect(n.origin).toBe('ai');
		expect(m.generate.pendingItems()).toHaveLength(1); // the flagged one waits for one-by-one review
		// Approved AI cards still never become evidence.
		m.indexer.requestIndex();
		await m.indexer.indexIdle();
		expect((m.indexDb.indexDb().prepare('SELECT text FROM chunk').pluck().all() as string[]).join(' ')).not.toContain('competitive inhibitor do to apparent Km');
	});

	it('quiz questions go through the answer-key check, and answers are recorded as practice', async () => {
		fakeAi({
			generate: () => ({ items: [{ stem: 'A noncompetitive inhibitor changes which parameter?', choices: ['Km only', 'Vmax only', 'Both', 'Neither'], answer: 1, explanation: 'It lowers Vmax; Km is unchanged.', sources: ['S1'] }] }),
			check: () => ({ verdicts: [{ index: 1, verdict: 'ok', note: '' }] })
		});
		await m.generate.generateItems({ documentId: DOC, sectionId: 'sec-1', kind: 'question', count: 1 });
		const q = m.generate.pendingItems().find((i) => i.kind === 'question')!;
		const qid = m.generate.approveItem(q.id);
		const [quiz] = m.generate.quizQuestions({ documentId: DOC });
		expect(quiz.id).toBe(qid);
		const wrong = m.generate.recordQuizAnswer(qid, 0, 5000);
		expect(wrong.correct).toBe(false);
		expect(m.generate.recordQuizAnswer(qid, 1, 4000).correct).toBe(true);
		const attempts = m.db.sqlite().prepare(`SELECT source, correct, aamc_code FROM attempt WHERE question_id = ?`).all(qid) as { source: string; correct: number; aamc_code: string }[];
		expect(attempts).toHaveLength(2);
		expect(attempts.every((a) => a.source === 'quiz' && a.aamc_code === '1A')).toBe(true);
	});
});

describe('connections and the monthly cap (AI-07)', () => {
	it('stops before calling the service once the month’s spending reaches the cap', async () => {
		const now = Date.now();
		m.db.db().insert(m.schema.aiProvider).values({ id: 'claude', apiKey: 'sk-ant-test-0000000000000000', model: 'claude-opus-5-5', monthlyCapUsd: 1, createdAt: now, updatedAt: now }).run();
		m.db.db().insert(m.schema.aiUsage).values({ id: 'u1', provider: 'claude', model: 'claude-opus-5-5', feature: 'tutor', inputTokens: 1, outputTokens: 1, costUsd: 1.25, month: new Date().toISOString().slice(0, 7), createdAt: now }).run();
		const fetchSpy = vi.fn();
		vi.stubGlobal('fetch', fetchSpy);
		await expect(m.providers.complete({ feature: 'tutor', system: 's', messages: [{ role: 'user', content: 'q' }] }, 'claude')).rejects.toMatchObject({ code: 'cap_reached' });
		expect(fetchSpy).not.toHaveBeenCalled();
		m.db.sqlite().prepare(`DELETE FROM ai_usage`).run();
	});

	it('calls Claude through the official SDK with structured output, effort and refusal fallbacks', async () => {
		let sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> } | null = null;
		const events = [
			{ type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1200, output_tokens: 0 } } },
			{ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '{"status":"answered","answer":"ok [S1]",' } },
			{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '"claims":[],"suggestion":""}' } },
			{ type: 'content_block_stop', index: 0 },
			{ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } },
			{ type: 'message_stop' }
		];
		vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
			const req = url instanceof Request ? url : null;
			const h = new Headers(req ? req.headers : init?.headers);
			const raw = req ? await req.text() : String(init?.body);
			sent = { url: req ? req.url : String(url), headers: Object.fromEntries(h.entries()), body: JSON.parse(raw) };
			const sse = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
			return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_test' } });
		});
		const now = Date.now();
		m.db.sqlite().prepare(`DELETE FROM ai_provider`).run();
		m.db.db().insert(m.schema.aiProvider).values({ id: 'claude', apiKey: 'sk-ant-test-0000000000000000', model: 'claude-opus-5-5', createdAt: now, updatedAt: now }).run();
		const r = await m.providers.complete({ feature: 'tutor', system: 'sys', messages: [{ role: 'user', content: 'q' }], schema: { type: 'object', properties: {}, additionalProperties: false } }, 'claude');
		expect(sent!.url).toContain('/v1/messages');
		// The SDK sends the key itself (as a bearer token with current API versions).
		expect(sent!.headers['x-api-key'] ?? sent!.headers.authorization).toMatch(/sk-ant-test-0000000000000000$/);
		expect(sent!.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
		expect(sent!.body.model).toBe('claude-opus-5-5');
		expect(sent!.body.fallbacks).toBe('default');
		expect(sent!.body.stream).toBe(true);
		expect((sent!.body.output_config as { format: { type: string } }).format.type).toBe('json_schema');
		expect(r.json).toEqual({ status: 'answered', answer: 'ok [S1]', claims: [], suggestion: '' });
		expect(r.costUsd).toBeCloseTo((1200 * 4 + 40 * 20) / 1e6, 8);
		m.db.sqlite().prepare(`DELETE FROM ai_provider`).run();
	});

	it('signs in with ChatGPT (PKCE, dynamic registration, verified ID token) and uses the plan for Responses API calls', async () => {
		const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
		let authorize: URL | null = null;
		const tokenBodies: URLSearchParams[] = [];
		let responsesBody: Record<string, unknown> | null = null;
		let responsesAuth = '';
		const idToken = (nonce: string) => {
			const header = Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' })).toString('base64url');
			const payload = Buffer.from(
				JSON.stringify({ iss: 'https://auth.openai.com', aud: 'oaiapp_test', sub: 'user-123', email: 'owner@example.com', nonce, exp: Math.floor(Date.now() / 1000) + 3600 })
			).toString('base64url');
			const sig = sign('RSA-SHA256', Buffer.from(`${header}.${payload}`), privateKey).toString('base64url');
			return `${header}.${payload}.${sig}`;
		};
		vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
			const u = String(url);
			if (u.endsWith('/.well-known/openid-configuration')) {
				return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/oauth/revoke' });
			}
			if (u.endsWith('/jwks.json')) return Response.json({ keys: [jwk] });
			if (u.endsWith('/api/accounts/oauth/token')) {
				const body = new URLSearchParams(String(init?.body));
				tokenBodies.push(body);
				if (body.get('grant_type') === 'refresh_token') return Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
				return Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', id_token: idToken(authorize!.searchParams.get('nonce')!), token_type: 'Bearer', expires_in: 3600, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
			}
			if (u === 'https://api.openai.com/v1/responses') {
				responsesAuth = new Headers(init?.headers).get('authorization') ?? '';
				responsesBody = JSON.parse(String(init?.body));
				const sse = [
					{ type: 'response.created' },
					{ type: 'response.output_text.delta', delta: '{"verdicts":[{"index":1,' },
					{ type: 'response.output_text.delta', delta: '"verdict":"supported","note":""}]}' },
					{ type: 'response.completed', response: { model: 'gpt-5.5', usage: { input_tokens: 300, output_tokens: 20 } } }
				]
					.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
					.join('');
				return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } });
			}
			throw new Error(`unexpected fetch ${u}`);
		});

		const start = m.chatgpt.startSignIn(new URL('http://localhost:8080/settings/ai'));
		authorize = new URL(start.url);
		expect(start.mode).toBe('direct');
		expect(authorize.origin + authorize.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
		expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client');
		expect(authorize.searchParams.get('agent_name_hint')).toBe('Medicus Vitae');
		expect(authorize.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:8080/auth/callback');
		expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
		expect(authorize.searchParams.get('scope')).toContain('chatgpt.tokens.use.direct');
		expect(authorize.searchParams.get('ext_agent_host_id')).toMatch(/^urn:uuid:/);

		const callback = new URLSearchParams({ code: 'auth-code', state: authorize.searchParams.get('state')!, client_id: 'oaiapp_test', scope: 'openid chatgpt.tokens.use.direct' });
		const done = await m.chatgpt.completeSignIn(callback);
		expect(done.planUsage).toBe(true);
		expect(tokenBodies[0].get('code_verifier')).toBeTruthy();
		expect(tokenBodies[0].get('resource')).toBe('https://api.openai.com/v1');
		expect(m.chatgpt.chatgptAccount()!.email).toBe('owner@example.com');
		expect(m.providers.providerConfigured('chatgpt')).toBe(true);

		const r = await m.providers.complete({ feature: 'check', system: 'checker', messages: [{ role: 'user', content: 'x' }], schema: { type: 'object', properties: {}, additionalProperties: false } }, 'chatgpt');
		expect(responsesAuth).toBe('Bearer access-1');
		expect(responsesBody!.store).toBe(false);
		expect(responsesBody!.stream).toBe(true);
		expect(responsesBody!.temperature).toBeUndefined();
		expect(responsesBody!.max_output_tokens).toBeUndefined();
		expect(r.json).toEqual({ verdicts: [{ index: 1, verdict: 'supported', note: '' }] });
		expect(r.costUsd).toBeNull(); // plan usage, not billed per token

		// Near expiry, the token is refreshed once and the rotated refresh token kept.
		const acct = m.chatgpt.chatgptAccount()!;
		m.db.kvSet('chatgpt_account', { ...acct, expiresAt: Date.now() + 10_000 });
		expect(await m.chatgpt.accessToken()).toBe('access-2');
		expect(m.chatgpt.chatgptAccount()!.refreshToken).toBe('refresh-2');
		expect(tokenBodies.at(-1)!.get('client_id')).toBe('oaiapp_test');

		// A pasted callback for an attempt this Cortex doesn't know is rejected clearly.
		await expect(m.chatgpt.completeSignIn(new URLSearchParams({ code: 'x', state: 'unknown' }))).rejects.toThrow(/older or different attempt/);
	});

	it('says clearly when the ChatGPT plan limit is reached and links to usage settings', async () => {
		vi.stubGlobal('fetch', async (url: string | URL | Request) => {
			if (String(url) === 'https://api.openai.com/v1/responses') {
				const e = { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded', message: 'limit' } } };
				return new Response(`event: response.failed\ndata: ${JSON.stringify(e)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } });
			}
			throw new Error('unexpected');
		});
		await expect(m.providers.complete({ feature: 'tutor', system: 's', messages: [{ role: 'user', content: 'q' }] }, 'chatgpt')).rejects.toMatchObject({
			code: 'usage_limit',
			manageUrl: 'https://chatgpt.com/settings/usage'
		});
	});
});
