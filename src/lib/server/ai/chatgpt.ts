import { createHash, createPublicKey, randomBytes, randomUUID, verify, type JsonWebKey } from 'node:crypto';
import { kvDelete, kvGet, kvSet } from '../db';

// "Sign in with ChatGPT" for open-source apps (AI-07): OpenAI's official way
// for a locally run app to use the owner's ChatGPT plan allowance, with no API
// key. OAuth 2.0 + PKCE against auth.openai.com; the app registers itself on
// first sign-in (client_id=dynamic_agent_client) and keeps the issued client id.
// Tokens are per device (this database's local store), never copied to the
// other device or into exports.
// Docs: https://developers.openai.com/siwc/token-sharing-open-source

const AUTH = 'https://auth.openai.com';
const AUTHORIZE = `${AUTH}/api/accounts/authorize`;
const TOKEN = `${AUTH}/api/accounts/oauth/token`;
const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
export const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const MANAGE_USAGE_URL = 'https://chatgpt.com/settings/usage';
/** The callback path never changes between sign-ins (OpenAI requires the same scheme, host and path). */
export const CALLBACK_PATH = '/auth/callback';
/** Used when Cortex runs on another machine: the browser lands on a page that doesn't load, and the owner pastes its address. */
export const PASTE_PORT = 1455;

export class ChatgptError extends Error {}

export interface ChatgptAccount {
	clientId: string;
	sub: string;
	email: string | null;
	name: string | null;
	accessToken: string | null;
	refreshToken: string | null;
	idToken: string;
	expiresAt: number;
	scopes: string[];
	model: string | null;
	connectedAt: number;
}

interface PendingFlow {
	verifier: string;
	nonce: string;
	redirectUri: string;
	clientId: string | null;
	returnTo: string;
	createdAt: number;
}

const pending = new Map<string, PendingFlow>();

function b64url(buf: Buffer) {
	return buf.toString('base64url');
}

/** Stable, opaque id for this device ("agent host"); not a credential. */
export function hostIdentifier(): string {
	let id = kvGet<string | null>('chatgpt_host_id', null);
	if (!id) {
		id = `urn:uuid:${randomUUID()}`;
		kvSet('chatgpt_host_id', id);
	}
	return id;
}

export function chatgptAccount(): ChatgptAccount | null {
	return kvGet<ChatgptAccount | null>('chatgpt_account', null);
}

function saveAccount(a: ChatgptAccount) {
	kvSet('chatgpt_account', a);
}

/** Whether the plan can be used now (signed in, tokens present, plan usage granted). */
export function chatgptReady(): boolean {
	const a = chatgptAccount();
	return !!a && !!a.refreshToken && a.scopes.includes(PLAN_SCOPE);
}

function isLoopback(host: string) {
	return /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(host);
}

/**
 * Starts a sign-in. When the owner is on this machine (localhost), the browser
 * comes straight back here; otherwise the callback address is shown to paste.
 */
export function startSignIn(origin: URL, opts: { forceConsent?: boolean } = {}) {
	for (const [state, f] of pending) if (Date.now() - f.createdAt > 30 * 60_000) pending.delete(state);
	const direct = isLoopback(origin.host);
	const port = direct ? Number(origin.port || (origin.protocol === 'https:' ? 443 : 80)) : PASTE_PORT;
	const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
	const verifier = b64url(randomBytes(32));
	const challenge = b64url(createHash('sha256').update(verifier).digest());
	const state = b64url(randomBytes(24));
	const nonce = b64url(randomBytes(24));
	const account = chatgptAccount();
	const clientId = account?.clientId ?? null;
	const params = new URLSearchParams({
		client_id: clientId ?? 'dynamic_agent_client',
		ext_agent_host_id: hostIdentifier(),
		response_type: 'code',
		redirect_uri: redirectUri,
		scope: SCOPES,
		resource: RESOURCE,
		state,
		nonce,
		code_challenge_method: 'S256',
		code_challenge: challenge
	});
	if (!clientId) params.set('agent_name_hint', 'Medicus Vitae');
	if (account?.idToken) params.set('id_token_hint', account.idToken);
	if (opts.forceConsent) params.set('prompt', 'consent');
	pending.set(state, { verifier, nonce, redirectUri, clientId, returnTo: `${origin.origin}/settings/ai`, createdAt: Date.now() });
	return { url: `${AUTHORIZE}?${params}`, mode: direct ? ('direct' as const) : ('paste' as const), redirectUri };
}

export function isPendingState(state: string | null) {
	return !!state && pending.has(state);
}

interface Jwks {
	keys: (JsonWebKey & { kid?: string })[];
}

let discovery: { issuer: string; jwks_uri: string; revocation_endpoint?: string; at: number } | null = null;
let jwks: { keys: Jwks['keys']; at: number } | null = null;

async function getDiscovery() {
	if (discovery && Date.now() - discovery.at < 3_600_000) return discovery;
	const r = await fetch(`${AUTH}/.well-known/openid-configuration`);
	if (!r.ok) throw new ChatgptError('Couldn’t reach OpenAI’s sign-in service.');
	const d = (await r.json()) as { issuer: string; jwks_uri: string; revocation_endpoint?: string };
	discovery = { ...d, at: Date.now() };
	return discovery;
}

async function getKeys(force = false) {
	if (!force && jwks && Date.now() - jwks.at < 3_600_000) return jwks.keys;
	const d = await getDiscovery();
	const r = await fetch(d.jwks_uri);
	if (!r.ok) throw new ChatgptError('Couldn’t check the sign-in (signing keys unavailable).');
	jwks = { keys: ((await r.json()) as Jwks).keys, at: Date.now() };
	return jwks.keys;
}

/** Verifies an ID token's signature (RS256) and claims, and returns its payload. */
export async function verifyIdToken(idToken: string, audience: string, nonce: string | null) {
	const parts = idToken.split('.');
	if (parts.length !== 3) throw new ChatgptError('The sign-in returned an unreadable identity token.');
	const header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')) as { alg: string; kid?: string };
	const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as Record<string, unknown>;
	if (header.alg !== 'RS256') throw new ChatgptError('Unexpected identity token type.');
	let keys = await getKeys();
	let jwk = keys.find((k) => k.kid === header.kid);
	if (!jwk) {
		keys = await getKeys(true);
		jwk = keys.find((k) => k.kid === header.kid);
	}
	if (!jwk) throw new ChatgptError('The identity token was signed with an unknown key.');
	const ok = verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(parts[2], 'base64url'));
	if (!ok) throw new ChatgptError('The identity token’s signature doesn’t check out.');
	const d = await getDiscovery();
	const aud = payload.aud;
	if (payload.iss !== d.issuer && payload.iss !== AUTH) throw new ChatgptError('The identity token came from an unexpected issuer.');
	if (!(aud === audience || (Array.isArray(aud) && aud.includes(audience)))) throw new ChatgptError('The identity token isn’t for this app.');
	if (typeof payload.exp === 'number' && payload.exp * 1000 < Date.now() - 60_000) throw new ChatgptError('The identity token has expired. Sign in again.');
	if (nonce !== null && payload.nonce !== nonce) throw new ChatgptError('The sign-in didn’t match the request (nonce). Try again.');
	return payload;
}

interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	id_token?: string;
	expires_in?: number;
	scope?: string;
	error?: string;
	error_description?: string;
}

async function tokenRequest(body: Record<string, string>): Promise<TokenResponse> {
	const r = await fetch(TOKEN, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
		body: new URLSearchParams(body)
	});
	const data = (await r.json().catch(() => ({}))) as TokenResponse;
	if (!r.ok || data.error) {
		const e = new ChatgptError(data.error_description || data.error || `Sign-in failed (${r.status}).`);
		(e as ChatgptError & { code?: string }).code = data.error;
		throw e;
	}
	return data;
}

/**
 * Finishes a sign-in from the callback's query (code, state, client_id, scope),
 * whether the browser came back here directly or the owner pasted the address.
 */
export async function completeSignIn(query: URLSearchParams): Promise<{ returnTo: string; planUsage: boolean }> {
	const state = query.get('state') ?? '';
	const flow = pending.get(state);
	if (!flow) throw new ChatgptError('That sign-in link is from an older or different attempt. Start the sign-in again.');
	pending.delete(state);
	if (query.get('error')) {
		throw new ChatgptError(query.get('error') === 'access_denied' ? 'Sign-in was cancelled.' : `Sign-in failed: ${query.get('error_description') || query.get('error')}`);
	}
	const code = query.get('code');
	if (!code) throw new ChatgptError('The sign-in address has no code in it. Copy the whole address from the browser’s address bar.');
	const returnedClient = query.get('client_id');
	if (flow.clientId && returnedClient && returnedClient !== flow.clientId) throw new ChatgptError('The sign-in came back for a different app registration.');
	const clientId = flow.clientId ?? returnedClient;
	if (!clientId) throw new ChatgptError('OpenAI didn’t return an app registration. Try signing in again.');
	const tokens = await tokenRequest({
		grant_type: 'authorization_code',
		client_id: clientId,
		code,
		code_verifier: flow.verifier,
		redirect_uri: flow.redirectUri,
		resource: RESOURCE
	});
	if (!tokens.id_token) throw new ChatgptError('The sign-in returned no identity token.');
	const claims = await verifyIdToken(tokens.id_token, clientId, flow.nonce);
	const previous = chatgptAccount();
	const scopes = (tokens.scope ?? query.get('scope') ?? '').split(/\s+/).filter(Boolean);
	saveAccount({
		clientId,
		sub: String(claims.sub ?? ''),
		email: typeof claims.email === 'string' ? claims.email : null,
		name: typeof claims.name === 'string' ? claims.name : null,
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token ?? null,
		idToken: tokens.id_token,
		expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
		scopes,
		model: previous && previous.sub === claims.sub ? previous.model : null,
		connectedAt: Date.now()
	});
	return { returnTo: flow.returnTo, planUsage: scopes.includes(PLAN_SCOPE) };
}

let refreshing: Promise<string> | null = null;

/** A valid access token, refreshed (once at a time) when it's about to expire. */
export async function accessToken(): Promise<string> {
	const a = chatgptAccount();
	if (!a?.refreshToken) throw new ChatgptError('Sign in with ChatGPT again (Settings › AI).');
	if (a.accessToken && a.expiresAt - Date.now() > 90_000) return a.accessToken;
	refreshing ??= (async () => {
		try {
			const tokens = await tokenRequest({ grant_type: 'refresh_token', client_id: a.clientId, refresh_token: a.refreshToken!, resource: RESOURCE });
			const next: ChatgptAccount = {
				...a,
				accessToken: tokens.access_token,
				refreshToken: tokens.refresh_token ?? a.refreshToken,
				idToken: tokens.id_token ?? a.idToken,
				expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
				scopes: tokens.scope ? tokens.scope.split(/\s+/).filter(Boolean) : a.scopes
			};
			saveAccount(next);
			return next.accessToken!;
		} catch (err) {
			const code = (err as { code?: string }).code ?? '';
			if (/invalid_grant|invalid_refresh_token|token_expired|refresh_token_(expired|invalidated|reused)/.test(code)) {
				// The session ended (signed out elsewhere, or expired): keep the registration, drop the tokens.
				saveAccount({ ...a, accessToken: null, refreshToken: null });
				throw new ChatgptError('Your ChatGPT sign-in has ended. Sign in again under Settings › AI.');
			}
			throw err;
		} finally {
			refreshing = null;
		}
	})();
	return refreshing;
}

/** Called when OpenAI says the token is no longer valid. */
export function markSignedOut() {
	const a = chatgptAccount();
	if (a) saveAccount({ ...a, accessToken: null, refreshToken: null });
}

export function setChatgptModel(model: string | null) {
	const a = chatgptAccount();
	if (a) saveAccount({ ...a, model });
}

/** Signs out: revokes the session at OpenAI when possible, and forgets the tokens (the registration is kept). */
export async function signOut(): Promise<{ revoked: boolean }> {
	const a = chatgptAccount();
	if (!a) return { revoked: true };
	let revoked = false;
	if (a.refreshToken) {
		try {
			const d = await getDiscovery();
			if (d.revocation_endpoint) {
				const r = await fetch(d.revocation_endpoint, {
					method: 'POST',
					headers: { 'content-type': 'application/x-www-form-urlencoded' },
					body: new URLSearchParams({ token: a.refreshToken, token_type_hint: 'refresh_token', client_id: a.clientId })
				});
				revoked = r.ok;
			}
		} catch {
			revoked = false;
		}
	}
	saveAccount({ ...a, accessToken: null, refreshToken: null });
	return { revoked };
}

/** Forgets everything, including the app registration (used by "Disconnect and forget"). */
export function forgetChatgpt() {
	kvDelete('chatgpt_account');
}

/** Models this ChatGPT account can use through Cortex. */
export async function listChatgptModels(): Promise<{ slug: string; name: string }[]> {
	const token = await accessToken();
	const r = await fetch('https://api.openai.com/v1/models', { headers: { authorization: `Bearer ${token}` } });
	if (!r.ok) throw new ChatgptError(`Couldn’t list models (${r.status}).`);
	const data = (await r.json()) as { models?: { slug: string; display_name?: string; visibility?: string }[]; data?: { id: string }[] };
	if (data.models) return data.models.filter((m) => m.visibility === 'list').map((m) => ({ slug: m.slug, name: m.display_name ?? m.slug }));
	return (data.data ?? []).map((m) => ({ slug: m.id, name: m.id }));
}
