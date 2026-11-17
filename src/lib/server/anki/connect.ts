import { kvGet, kvSet } from '../db';

// AnkiConnect: the add-on (code 2055492159) that lets apps talk to Anki
// desktop at http://127.0.0.1:8765 while Anki is open. Medicus uses it to sync
// with the owner's Anki profile, and through Anki's own AnkiWeb sync, with
// Anki on their phone.

export interface AnkiConnectConfig {
	url: string;
	/** Only if the add-on's settings set an apiKey. */
	key: string | null;
	/** Sync automatically while Anki is open. */
	auto: boolean;
	autoMinutes: number;
	/** Have Anki desktop sync with AnkiWeb before and after (so the phone gets the changes). */
	ankiWeb: boolean;
	/** Send cards made here to Anki, into this deck. */
	pushOwnCards: boolean;
	pushDeck: string;
}

export const DEFAULT_ANKI_CONNECT: AnkiConnectConfig = {
	url: 'http://127.0.0.1:8765',
	key: null,
	auto: true,
	autoMinutes: 10,
	ankiWeb: true,
	pushOwnCards: true,
	pushDeck: 'Medicus'
};

export function ankiConnectConfig(): AnkiConnectConfig {
	const saved = kvGet<Partial<AnkiConnectConfig> | null>('anki_connect', null) ?? {};
	const c = { ...DEFAULT_ANKI_CONNECT, ...saved };
	return {
		url: typeof c.url === 'string' && /^https?:\/\//.test(c.url) ? c.url.replace(/\/+$/, '') : DEFAULT_ANKI_CONNECT.url,
		key: typeof c.key === 'string' && c.key.trim() ? c.key.trim() : null,
		auto: c.auto !== false,
		autoMinutes: Math.max(2, Math.min(240, Math.round(Number(c.autoMinutes) || 10))),
		ankiWeb: c.ankiWeb !== false,
		pushOwnCards: c.pushOwnCards !== false,
		pushDeck: String(c.pushDeck || 'Medicus').replace(/["]/g, '').trim().slice(0, 100) || 'Medicus'
	};
}

export function setAnkiConnectConfig(patch: Partial<AnkiConnectConfig>) {
	const next = { ...ankiConnectConfig(), ...patch };
	kvSet('anki_connect', next);
	return ankiConnectConfig();
}

export class AnkiConnectError extends Error {
	constructor(
		message: string,
		/** unreachable: Anki isn't open or the add-on isn't installed. */
		public code: 'unreachable' | 'denied' | 'error' = 'error'
	) {
		super(message);
	}
}

/** Test hook: a stand-in for AnkiConnect. */
let fetcher: typeof fetch | null = null;
export function setAnkiFetch(fn: typeof fetch | null) {
	fetcher = fn;
}

/** One AnkiConnect action (API version 6). */
export async function invoke<T = unknown>(action: string, params: Record<string, unknown> = {}, opts: { timeoutMs?: number; cfg?: AnkiConnectConfig } = {}): Promise<T> {
	const cfg = opts.cfg ?? ankiConnectConfig();
	const body: Record<string, unknown> = { action, version: 6, params };
	if (cfg.key) body.key = cfg.key;
	let res: Response;
	try {
		res = await (fetcher ?? fetch)(cfg.url, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000)
		});
	} catch (err) {
		const timedOut = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
		throw new AnkiConnectError(
			timedOut ? `Anki didn’t answer “${action}” in time. Is a window open in Anki waiting for you?` : 'Can’t reach Anki. Open Anki on this computer and make sure the AnkiConnect add-on is installed.',
			timedOut ? 'error' : 'unreachable'
		);
	}
	let data: { result?: T; error?: string | null } | null = null;
	try {
		data = (await res.json()) as { result?: T; error?: string | null };
	} catch {
		throw new AnkiConnectError('Anki sent an answer this app didn’t understand. Update the AnkiConnect add-on.');
	}
	if (data && data.error) {
		const msg = String(data.error);
		if (/valid api key|permission/i.test(msg)) throw new AnkiConnectError('AnkiConnect wants an API key. Enter the key from its settings here.', 'denied');
		throw new AnkiConnectError(`Anki said: ${msg}`);
	}
	return (data?.result ?? null) as T;
}

export interface AnkiStatus {
	reachable: boolean;
	version: number | null;
	decks: string[];
	message: string;
}

/** Is Anki open with AnkiConnect, and which decks does it have? */
export async function ankiStatus(): Promise<AnkiStatus> {
	try {
		const perm = await invoke<{ permission: string; version?: number }>('requestPermission', {}, { timeoutMs: 6000 });
		if (perm?.permission && perm.permission !== 'granted') {
			return { reachable: false, version: null, decks: [], message: 'Anki asked whether to allow this app. Click “Yes” in Anki, then check again.' };
		}
		const version = await invoke<number>('version', {}, { timeoutMs: 6000 });
		const decks = (await invoke<string[]>('deckNames', {}, { timeoutMs: 8000 })) ?? [];
		if (version < 6) return { reachable: true, version, decks, message: 'This AnkiConnect is too old. Update it in Anki: Tools › Add-ons › Check for updates.' };
		return { reachable: true, version, decks: decks.sort((a, b) => a.localeCompare(b)), message: 'Connected to Anki.' };
	} catch (err) {
		return { reachable: false, version: null, decks: [], message: err instanceof Error ? err.message : String(err) };
	}
}
