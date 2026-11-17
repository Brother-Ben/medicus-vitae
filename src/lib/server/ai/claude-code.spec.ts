// The Claude plan connection through Claude Code, against a stand-in `claude`
// program: what Cortex runs (no tools, no history, its own sign-in, never an API
// key), how answers and errors come back, and which accounts it finds.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-cc-'));
process.env.CORTEX_DATA_DIR = dir;
process.env.CORTEX_ENV_LOADED = '1';

const fake = path.join(dir, 'fake-claude.mjs');
const log = path.join(dir, 'fake-claude.log');
fs.writeFileSync(
	fake,
	`import fs from 'node:fs';
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('2.1.999 (Claude Code)'); process.exit(0); }
if (args[0] === '--help') { console.log('Usage: claude [options] --safe-mode --json-schema <schema> --tools <tools...> --no-session-persistence --strict-mcp-config --effort <level> --system-prompt[-file]'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({ loggedIn: true, email: process.env.CLAUDE_CONFIG_DIR ? 'other@example.com' : 'main@example.com', subscriptionType: 'max', authMethod: 'claude.ai' })); process.exit(0); }
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
	const get = (f) => { const i = args.indexOf(f); return i === -1 ? null : args[i + 1]; };
	const system = get('--system-prompt-file') ? fs.readFileSync(get('--system-prompt-file'), 'utf8') : get('--system-prompt');
	fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ args, system, input, apiKey: process.env.ANTHROPIC_API_KEY ?? null, configDir: process.env.CLAUDE_CONFIG_DIR ?? null, cwd: process.cwd() }) + '\\n');
	if (input.includes('LIMIT')) { console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: "You've hit your limit · resets 3pm", api_error_status: 429 })); process.exit(1); }
	if (input.includes('SIGNEDOUT')) { console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login' })); process.exit(1); }
	const schema = get('--json-schema');
	const out = { type: 'result', subtype: 'success', is_error: false, result: schema ? '{"ok":true}' : 'OK', usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 3 }, modelUsage: { 'claude-sonnet-5-5': {} } };
	if (schema) out.structured_output = { ok: true, schemaTitle: JSON.parse(schema).title ?? null };
	console.log(JSON.stringify(out));
});
`
);

type Mods = {
	config: typeof import('../config');
	db: typeof import('../db');
	schema: typeof import('../db/schema');
	instance: typeof import('../instance');
	cc: typeof import('./claude-code');
	providers: typeof import('./providers');
};
let m: Mods;
const lastRun = () => {
	const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
	return JSON.parse(lines[lines.length - 1]) as { args: string[]; system: string; input: string; apiKey: string | null; configDir: string | null; cwd: string };
};

beforeAll(async () => {
	m = {
		config: await import('../config'),
		db: await import('../db'),
		schema: await import('../db/schema'),
		instance: await import('../instance'),
		cc: await import('./claude-code'),
		providers: await import('./providers')
	};
	m.config.ensureDataDirs();
	m.db.openLocalDatabase();
	await m.db.openMainDatabase();
	m.instance.ensureInstance();
	const t = Date.now();
	m.db.db().insert(m.schema.user).values({ id: 1, passwordHash: 'x', createdAt: t, updatedAt: t }).run();
});

afterAll(() => {
	m?.db.closeDatabases();
	fs.rmSync(dir, { recursive: true, force: true });
});

describe('Claude plan through Claude Code', () => {
	it('is the connection in use once set up, and needs no API key', () => {
		expect(m.providers.providerConfigured('claude_code')).toBe(false);
		m.cc.saveClaudeCodeSettings({ exe: fake, configDir: null, model: 'sonnet' });
		expect(m.providers.providerConfigured('claude_code')).toBe(true);
		expect(m.providers.activeProviderId()).toBe('claude_code');
	});

	it('runs Claude Code without tools or history, with the system prompt and a transcript, and never passes an API key', async () => {
		process.env.ANTHROPIC_API_KEY = 'sk-ant-should-not-be-used';
		const r = await m.providers.complete(
			{
				feature: 'tutor',
				system: 'You are the tutor.',
				messages: [
					{ role: 'user', content: 'What is Km?' },
					{ role: 'assistant', content: 'The substrate concentration at half Vmax.' },
					{ role: 'user', content: 'And a low Km means?' }
				],
				schema: { title: 'answer', type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] },
				effort: 'low'
			},
			'claude_code'
		);
		delete process.env.ANTHROPIC_API_KEY;
		expect(r.json).toEqual({ ok: true, schemaTitle: 'answer' });
		expect(r.provider).toBe('claude_code');
		expect(r.model).toBe('claude-sonnet-5-5');
		expect(r.inputTokens).toBe(15);
		expect(r.costUsd).toBeNull(); // plan usage, not billed per token

		const run = lastRun();
		expect(run.args.slice(0, 3)).toEqual(['-p', '--output-format', 'json']);
		expect(run.args).toEqual(expect.arrayContaining(['--no-session-persistence', '--strict-mcp-config', '--safe-mode', '--json-schema']));
		expect(run.args[run.args.indexOf('--tools') + 1]).toBe('');
		expect(run.args[run.args.indexOf('--model') + 1]).toBe('sonnet');
		expect(run.args[run.args.indexOf('--effort') + 1]).toBe('low');
		expect(run.system).toBe('You are the tutor.');
		expect(run.input).toContain('Earlier in this conversation');
		expect(run.input).toContain('<assistant>\nThe substrate concentration at half Vmax.\n</assistant>');
		expect(run.input.trim().endsWith('And a low Km means?')).toBe(true);
		expect(run.apiKey).toBeNull();
		expect(run.configDir).toBeNull();
		expect(path.resolve(run.cwd)).toBe(path.resolve(m.config.config.paths.tmp, 'claude-code'));
		// The system prompt file is removed afterwards.
		expect(fs.readdirSync(path.join(m.config.config.paths.tmp, 'claude-code'))).toEqual([]);
	});

	it('uses the chosen account’s Claude Code settings folder', async () => {
		const other = path.join(dir, '.claude-other');
		fs.mkdirSync(other, { recursive: true });
		m.cc.saveClaudeCodeSettings({ exe: fake, configDir: other, model: null });
		await m.providers.complete({ feature: 'check', system: 's', messages: [{ role: 'user', content: 'x' }] }, 'claude_code');
		const run = lastRun();
		expect(run.configDir).toBe(other);
		expect(run.args).not.toContain('--model');
	});

	it('says plainly when the plan limit is reached or Claude Code is signed out', async () => {
		await expect(m.providers.complete({ feature: 'tutor', system: 's', messages: [{ role: 'user', content: 'LIMIT please' }] }, 'claude_code')).rejects.toMatchObject({
			code: 'usage_limit',
			manageUrl: 'https://claude.ai/settings/usage'
		});
		await expect(m.providers.complete({ feature: 'tutor', system: 's', messages: [{ role: 'user', content: 'SIGNEDOUT' }] }, 'claude_code')).rejects.toMatchObject({ code: 'auth' });
	});

	it('finds the signed-in accounts and records usage as plan usage', async () => {
		const accounts = await m.cc.claudeCodeAccounts(fake);
		expect(accounts[0]).toMatchObject({ configDir: null, loggedIn: true, email: 'main@example.com', plan: 'max' });
		const usage = m.providers.monthUsage().filter((u) => u.provider === 'claude_code');
		expect(usage.reduce((n, u) => n + u.requests, 0)).toBe(2);
		expect(usage.every((u) => u.cost === null)).toBe(true);
	});

	it('reports a missing Claude Code as not connected', async () => {
		m.cc.saveClaudeCodeSettings({ exe: path.join(dir, 'nowhere', 'claude.exe'), configDir: null, model: null });
		const original = process.env.PATH;
		process.env.PATH = dir; // nothing called claude on PATH either
		try {
			const found = m.cc.findClaudeExecutables();
			if (!found.length) {
				expect(m.providers.providerConfigured('claude_code')).toBe(false);
				await expect(m.providers.complete({ feature: 'tutor', system: 's', messages: [{ role: 'user', content: 'x' }] }, 'claude_code')).rejects.toMatchObject({ code: 'not_connected' });
			} else {
				// This computer has a real Claude Code in a usual place: it is found instead.
				expect(m.cc.resolveClaudeExe()).toBe(found[0]);
			}
		} finally {
			process.env.PATH = original;
		}
	});
});
