import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { config } from '../config';
import { kvDelete, kvGet, kvSet } from '../db';

// "Claude plan (through Claude Code)": the tutor uses the owner's own Claude
// Pro/Max plan by running Claude Code, Anthropic's app, already installed and
// signed in on this computer. Cortex runs it in its non-interactive mode
// (`claude -p`) with every tool turned off, no MCP servers, plugins, hooks or
// CLAUDE.md files (--safe-mode), and nothing saved to Claude Code's history.
// Claude Code signs in by itself: Cortex never reads, stores or passes on the
// Claude login. Requests count toward the plan's usage limits like any other
// Claude Code use. (Anthropic doesn't let apps offer Claude.ai sign-in or handle
// those credentials; running your own signed-in Claude Code is what its terms
// leave open: https://code.claude.com/docs/en/legal-and-compliance)

export class ClaudeCodeError extends Error {
	constructor(
		message: string,
		public code: 'not_installed' | 'auth' | 'usage_limit' | 'refused' | 'unavailable' | 'bad_output' | 'timeout'
	) {
		super(message);
	}
}

export interface ClaudeCodeSettings {
	/** claude.exe (or claude.cmd, or a cli.js) chosen in Settings; null = look for it. */
	exe: string | null;
	/** Claude Code's settings folder for the account to use (CLAUDE_CONFIG_DIR); null = its default. */
	configDir: string | null;
	/** A model alias (opus, sonnet, …) or full name; null = Claude Code's own default. */
	model: string | null;
	connectedAt: number;
}

const KEY = 'claude_code';

/** Per device (the program lives on this computer), like the ChatGPT sign-in. */
export function claudeCodeSettings(): ClaudeCodeSettings | null {
	return kvGet<ClaudeCodeSettings | null>(KEY, null);
}

export function saveClaudeCodeSettings(s: Omit<ClaudeCodeSettings, 'connectedAt'> & { connectedAt?: number }) {
	kvSet(KEY, { ...s, connectedAt: s.connectedAt ?? Date.now() });
}

export function forgetClaudeCode() {
	kvDelete(KEY);
}

// ----------------------------------------------------------- finding it

const isWindows = process.platform === 'win32';

function isFile(p: string) {
	try {
		return fs.statSync(p).isFile();
	} catch {
		return false;
	}
}

/** Places Claude Code is installed: the native installer, npm, and PATH. */
export function findClaudeExecutables(): string[] {
	const home = os.homedir();
	const found = new Set<string>();
	const names = isWindows ? ['claude.exe', 'claude.cmd'] : ['claude'];
	const usual = isWindows
		? [
				path.join(home, '.local', 'bin', 'claude.exe'),
				path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'npm', 'claude.cmd'),
				path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), 'Programs', 'claude', 'claude.exe')
			]
		: [path.join(home, '.local', 'bin', 'claude'), path.join(home, '.claude', 'local', 'claude'), '/usr/local/bin/claude', '/opt/homebrew/bin/claude', '/usr/bin/claude'];
	for (const p of usual) if (isFile(p)) found.add(p);
	for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
		if (!dir) continue;
		for (const n of names) {
			const p = path.join(dir, n);
			if (isFile(p)) found.add(p);
		}
	}
	return [...found];
}

/** The program to run: the one chosen in Settings if it still exists, else the first one found. */
export function resolveClaudeExe(s: ClaudeCodeSettings | null = claudeCodeSettings()): string | null {
	if (s?.exe && isFile(s.exe)) return s.exe;
	return findClaudeExecutables()[0] ?? null;
}

interface Command {
	file: string;
	args: string[];
	windowsVerbatimArguments?: boolean;
}

function quoteForCmd(arg: string) {
	if (arg === '') return '""';
	if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
	return `"${arg.replace(/"/g, '""')}"`;
}

/** How to start it: an .exe directly, a .cmd through cmd.exe, a .js with this Node. */
function command(exe: string, args: string[]): Command {
	if (/\.(c|m)?js$/i.test(exe)) return { file: process.execPath, args: [exe, ...args] };
	if (isWindows && /\.(cmd|bat)$/i.test(exe)) {
		return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[exe, ...args].map(quoteForCmd).join(' ')}"`], windowsVerbatimArguments: true };
	}
	return { file: exe, args };
}

/** The environment Claude Code runs with: its own sign-in, never an API key Cortex happens to have. */
function childEnv(configDir: string | null): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	// An API key in the environment would make Claude Code bill the API instead of the plan.
	for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT']) delete env[k];
	if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
	env.DISABLE_AUTOUPDATER = '1';
	return env;
}

function runQuick(exe: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs = 20_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const cmd = command(exe, args);
	return new Promise((resolve) => {
		execFile(
			cmd.file,
			cmd.args,
			{ env, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, windowsVerbatimArguments: cmd.windowsVerbatimArguments, cwd: os.homedir() },
			(err, stdout, stderr) => {
				const code = err && typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code as number) : err ? null : 0;
				resolve({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
			}
		);
	});
}

export interface Capabilities {
	version: string | null;
	safeMode: boolean;
	jsonSchema: boolean;
	tools: boolean;
	systemPromptFile: boolean;
	noSessionPersistence: boolean;
	strictMcp: boolean;
	effort: boolean;
	allowedTools: boolean;
	dontAsk: boolean;
	maxTurns: boolean;
}

const capsCache = new Map<string, { mtime: number; caps: Capabilities }>();

/** What this Claude Code version supports (from its --help), so older versions still work. */
export async function capabilities(exe: string): Promise<Capabilities> {
	let mtime = 0;
	try {
		mtime = fs.statSync(exe).mtimeMs;
	} catch {
		// checked by the caller
	}
	const cached = capsCache.get(exe);
	if (cached && cached.mtime === mtime) return cached.caps;
	const env = childEnv(null);
	const [ver, help] = await Promise.all([runQuick(exe, ['--version'], env), runQuick(exe, ['--help'], env)]);
	const h = help.stdout;
	const caps: Capabilities = {
		version: /(\d+\.\d+\.\d+)/.exec(ver.stdout)?.[1] ?? null,
		safeMode: h.includes('--safe-mode'),
		jsonSchema: h.includes('--json-schema'),
		tools: h.includes('--tools'),
		systemPromptFile: h.includes('system-prompt-file') || h.includes('system-prompt[-file]'),
		noSessionPersistence: h.includes('--no-session-persistence'),
		strictMcp: h.includes('--strict-mcp-config'),
		effort: h.includes('--effort'),
		allowedTools: h.includes('--allowedTools') || h.includes('--allowed-tools'),
		dontAsk: h.includes('dontAsk'),
		maxTurns: h.includes('--max-turns')
	};
	if (caps.version) capsCache.set(exe, { mtime, caps });
	return caps;
}

// ------------------------------------------------------------ accounts

export interface ClaudeCodeAccount {
	/** CLAUDE_CONFIG_DIR, or null for Claude Code's default folder. */
	configDir: string | null;
	folder: string;
	loggedIn: boolean;
	email: string | null;
	plan: string | null;
	authMethod: string | null;
}

/** Claude Code settings folders in the home folder: ~/.claude, and any ~/.claude-<name> made for another account. */
function configFolders(): (string | null)[] {
	const home = os.homedir();
	const out: (string | null)[] = [null];
	try {
		for (const name of fs.readdirSync(home)) {
			if (!/^\.claude[-_.][\w.-]+$/.test(name)) continue;
			const dir = path.join(home, name);
			try {
				if (!fs.statSync(dir).isDirectory()) continue;
			} catch {
				continue;
			}
			// A Claude Code settings folder has its own sign-in or settings file.
			if (['.credentials.json', '.claude.json', 'settings.json'].some((f) => isFile(path.join(dir, f)))) out.push(dir);
		}
	} catch {
		// no home folder listing: only the default
	}
	return out;
}

/** Who each Claude Code settings folder is signed in as (asks Claude Code: `claude auth status`). */
export async function claudeCodeAccounts(exe: string): Promise<ClaudeCodeAccount[]> {
	return Promise.all(
		configFolders().map(async (configDir) => {
			let r = await runQuick(exe, ['auth', 'status', '--json'], childEnv(configDir), 20_000);
			// Versions without --json print JSON by default.
			if (!r.stdout.includes('{')) r = await runQuick(exe, ['auth', 'status'], childEnv(configDir), 20_000);
			let info: Record<string, unknown> = {};
			try {
				info = JSON.parse(r.stdout.slice(r.stdout.indexOf('{')));
			} catch {
				// older versions: no JSON status; treat as unknown
			}
			return {
				configDir,
				folder: configDir ?? path.join(os.homedir(), '.claude'),
				loggedIn: info.loggedIn === true,
				email: typeof info.email === 'string' ? info.email : null,
				plan: typeof info.subscriptionType === 'string' ? info.subscriptionType : null,
				authMethod: typeof info.authMethod === 'string' ? info.authMethod : null
			};
		})
	);
}

// ------------------------------------------------------------- running

export interface ClaudeCodeRequest {
	system: string;
	prompt: string;
	schema?: Record<string, unknown>;
	effort?: 'low' | 'medium' | 'high';
	timeoutMs?: number;
	/** Research mode: Claude Code's WebSearch and WebFetch tools on (and nothing else). */
	webTools?: boolean;
}

export interface ClaudeCodeResult {
	text: string;
	json: unknown;
	model: string;
	inputTokens: number;
	outputTokens: number;
}

let running = 0;
const waiting: (() => void)[] = [];

/** At most two Claude Code processes at a time. */
async function slot<T>(fn: () => Promise<T>): Promise<T> {
	if (running >= 2) await new Promise<void>((r) => waiting.push(r));
	running++;
	try {
		return await fn();
	} finally {
		running--;
		waiting.shift()?.();
	}
}

function workDir() {
	// A fixed, empty folder: Claude Code treats its working folder as a project, so one is enough.
	const dir = path.join(config.paths.tmp, 'claude-code');
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

function limitMessage(text: string) {
	const reset = /\|(\d{10})\b/.exec(text);
	const when = reset ? new Date(Number(reset[1]) * 1000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : null;
	return `Your Claude plan’s usage limit has been reached${when ? ` (it resets ${when})` : ''}. Claude Code said: ${text.replace(/\|\d{10}\b/, '').trim()}`;
}

function failure(text: string, status: number | null): ClaudeCodeError {
	const t = text.trim() || 'Claude Code stopped without an answer.';
	if (status === 401 || status === 403 || /not logged in|please run \/login|log ?in again|invalid (api key|bearer)|authenticat|oauth token/i.test(t)) {
		return new ClaudeCodeError('Claude Code on this computer isn’t signed in (or its sign-in expired). Open a terminal, run claude, and sign in with your Claude account, then try again.', 'auth');
	}
	if (status === 429 || /usage limit|limit reached|hit your limit|rate limit|out of (extra )?usage/i.test(t)) return new ClaudeCodeError(limitMessage(t), 'usage_limit');
	if (/refus|declin/i.test(t) && !/connect/i.test(t)) return new ClaudeCodeError(`Claude declined this request: ${t}`, 'refused');
	return new ClaudeCodeError(`Claude Code couldn’t answer: ${t.split('\n')[0].slice(0, 300)}`, 'unavailable');
}

/** Runs one request through Claude Code and returns its answer. */
export async function claudeCodeRun(req: ClaudeCodeRequest, settings: ClaudeCodeSettings | null = claudeCodeSettings()): Promise<ClaudeCodeResult> {
	const exe = resolveClaudeExe(settings);
	if (!exe) throw new ClaudeCodeError('Claude Code isn’t installed on this computer (or Medicus Vitae can’t find it). Install it, or choose where it is, in Settings › AI.', 'not_installed');
	const caps = await capabilities(exe);
	if (!caps.version) throw new ClaudeCodeError(`The program at ${exe} didn’t answer like Claude Code does. Choose Claude Code’s claude program in Settings › AI.`, 'not_installed');
	return slot(async () => {
		const dir = workDir();
		const systemFile = path.join(dir, `system-${randomUUID()}.txt`);
		const viaCmd = isWindows && /\.(cmd|bat)$/i.test(exe);
		// Through cmd.exe, inline JSON is unreliable to quote: ask for the JSON in words instead.
		const nativeSchema = !!req.schema && caps.jsonSchema && !viaCmd;
		const args = ['-p', '--output-format', 'json'];
		if (caps.noSessionPersistence) args.push('--no-session-persistence');
		if (req.webTools) {
			if (!caps.tools || !caps.allowedTools) throw new ClaudeCodeError('This version of Claude Code can’t be limited to web search. Update Claude Code (claude update) to use Research.', 'unavailable');
			// Only the two web tools exist for this run, pre-approved; anything else would be refused.
			args.push('--tools', 'WebSearch,WebFetch', '--allowedTools', 'WebSearch,WebFetch');
			if (caps.dontAsk) args.push('--permission-mode', 'dontAsk');
			if (caps.maxTurns) args.push('--max-turns', '12');
		} else if (caps.tools) args.push('--tools', '');
		if (caps.strictMcp) args.push('--strict-mcp-config');
		if (caps.safeMode) args.push('--safe-mode');
		if (caps.systemPromptFile) {
			fs.writeFileSync(systemFile, req.system);
			args.push('--system-prompt-file', systemFile);
		} else {
			args.push('--system-prompt', req.system);
		}
		if (settings?.model) args.push('--model', settings.model);
		if (req.effort && caps.effort) args.push('--effort', req.effort);
		if (nativeSchema) args.push('--json-schema', JSON.stringify(req.schema));
		const prompt =
			req.schema && !nativeSchema ? `${req.prompt}\n\nReply with a single JSON object only, matching this JSON Schema:\n${JSON.stringify(req.schema)}` : req.prompt;

		const cmd = command(exe, args);
		try {
			const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
				const child = spawn(cmd.file, cmd.args, {
					cwd: dir,
					env: childEnv(settings?.configDir ?? null),
					windowsHide: true,
					windowsVerbatimArguments: cmd.windowsVerbatimArguments
				});
				let stdout = '';
				let stderr = '';
				const timer = setTimeout(() => {
					child.kill();
					reject(new ClaudeCodeError('Claude Code took too long to answer (over 5 minutes) and was stopped. Try again.', 'timeout'));
				}, req.timeoutMs ?? 5 * 60_000);
				child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
				child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
				child.on('error', (err) => {
					clearTimeout(timer);
					reject(new ClaudeCodeError(`Couldn’t start Claude Code (${exe}): ${err.message}`, 'not_installed'));
				});
				child.on('close', (code) => {
					clearTimeout(timer);
					resolve({ code, stdout, stderr });
				});
				child.stdin.on('error', () => {});
				child.stdin.end(prompt);
			});

			let result: Record<string, unknown> | null = null;
			const start = out.stdout.indexOf('{');
			if (start !== -1) {
				try {
					result = JSON.parse(out.stdout.slice(start));
				} catch {
					result = null;
				}
			}
			if (!result) throw failure(out.stderr || out.stdout, null);
			const text = typeof result.result === 'string' ? result.result : '';
			const status = typeof result.api_error_status === 'number' ? result.api_error_status : null;
			if (result.is_error || (result.subtype && result.subtype !== 'success')) throw failure(text || out.stderr || String(result.subtype ?? ''), status);
			let json: unknown = null;
			if (req.schema) {
				json = result.structured_output ?? null;
				if (json === null) {
					try {
						json = JSON.parse(text.trim().replace(/^```(?:json)?\s*|```$/g, ''));
					} catch {
						throw new ClaudeCodeError('Claude Code’s answer wasn’t in the expected format. Try again.', 'bad_output');
					}
				}
			}
			const usage = (result.usage ?? {}) as Record<string, number>;
			const modelUsage = (result.modelUsage ?? {}) as Record<string, unknown>;
			return {
				text,
				json,
				model: Object.keys(modelUsage)[0] ?? settings?.model ?? 'claude',
				inputTokens: (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
				outputTokens: usage.output_tokens ?? 0
			};
		} finally {
			fs.rmSync(systemFile, { force: true });
		}
	});
}
