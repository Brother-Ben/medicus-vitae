import { createHash } from 'node:crypto';
import argon2 from 'argon2';
import { eq } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';
import { db, local } from './db';
import { recoveryCode, user } from './db/schema';
import { token } from './ids';

export const SESSION_COOKIE = 'cortex_session';
const SESSION_DAYS = 30;

// Signing in takes the password only. Two-factor sign-in was removed on
// 2026-11-16; a 'needs_2fa' session left over from before then is never
// treated as signed in (hooks.server.ts lets only 'full' sessions through).
export type SessionStage = 'full' | 'needs_2fa';

export interface SessionInfo {
	id: string;
	stage: SessionStage;
	expiresAt: number;
}

// ------------------------------------------------------------ passwords

export function hashPassword(password: string) {
	return argon2.hash(password, { type: argon2.argon2id });
}

export async function verifyPassword(hash: string, password: string) {
	try {
		return await argon2.verify(hash, password);
	} catch {
		return false;
	}
}

export function passwordProblem(password: string): string | null {
	if (password.length < 8) return 'Use at least 8 characters.';
	if (password.length > 512) return 'That password is too long.';
	return null;
}

export function getUser() {
	return db().select().from(user).where(eq(user.id, 1)).get();
}

export function hasUser() {
	return !!getUser();
}

// ------------------------------------------------------------- sessions

function sha256(value: string) {
	return createHash('sha256').update(value).digest('hex');
}

export function createSession(userAgent = ''): { token: string; info: SessionInfo } {
	const raw = token(32);
	const now = Date.now();
	const stage: SessionStage = 'full';
	const info: SessionInfo = { id: sha256(raw), stage, expiresAt: now + SESSION_DAYS * 86_400_000 };
	local()
		.prepare(
			'INSERT INTO session (id, stage, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)'
		)
		.run(info.id, stage, now, info.expiresAt, now, userAgent.slice(0, 300));
	return { token: raw, info };
}

export function validateSession(raw: string | undefined): SessionInfo | null {
	if (!raw) return null;
	const id = sha256(raw);
	const row = local().prepare('SELECT id, stage, expires_at, last_seen_at FROM session WHERE id = ?').get(id) as
		| { id: string; stage: SessionStage; expires_at: number; last_seen_at: number }
		| undefined;
	if (!row) return null;
	const now = Date.now();
	if (row.expires_at <= now) {
		local().prepare('DELETE FROM session WHERE id = ?').run(id);
		return null;
	}
	// Sliding expiry for full sessions, refreshed at most hourly.
	if (row.stage === 'full' && now - row.last_seen_at > 3_600_000) {
		const expiresAt = now + SESSION_DAYS * 86_400_000;
		local().prepare('UPDATE session SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(now, expiresAt, id);
		return { id, stage: row.stage, expiresAt };
	}
	return { id, stage: row.stage, expiresAt: row.expires_at };
}

export function deleteSession(id: string) {
	local().prepare('DELETE FROM session WHERE id = ?').run(id);
}

export function deleteAllSessions(exceptId?: string) {
	if (exceptId) local().prepare('DELETE FROM session WHERE id != ?').run(exceptId);
	else local().prepare('DELETE FROM session').run();
}

export function purgeExpiredSessions() {
	local().prepare('DELETE FROM session WHERE expires_at <= ?').run(Date.now());
}

export function setSessionCookie(cookies: Cookies, raw: string, info: SessionInfo, secure: boolean) {
	cookies.set(SESSION_COOKIE, raw, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		expires: new Date(info.expiresAt)
	});
}

export function clearSessionCookie(cookies: Cookies) {
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

/**
 * Clears an authenticator secret and recovery codes saved while two-factor
 * sign-in existed, so they can't come back (for example after restoring an
 * older version of the app). Runs at startup on the primary.
 */
export function clearTwoFactor() {
	const u = db().select({ on: user.totpEnabled, secret: user.totpSecret }).from(user).where(eq(user.id, 1)).get();
	if (!u || (!u.on && !u.secret)) return;
	db().transaction((tx) => {
		tx.update(user).set({ totpEnabled: false, totpSecret: null, updatedAt: Date.now() }).where(eq(user.id, 1)).run();
		tx.delete(recoveryCode).run();
	});
	console.log('Two-factor sign-in removed: cleared the saved authenticator key and recovery codes.');
}
