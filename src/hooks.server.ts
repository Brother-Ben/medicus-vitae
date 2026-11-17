import { redirect } from '@sveltejs/kit';
import type { Handle, HandleServerError, ServerInit } from '@sveltejs/kit/hooks';
import { building } from '$app/env';
import { SEASON_THEMES, seasonOfDate } from '#lib/appearance.js';
import { BOOT_SCRIPT } from '#lib/appearance-boot.js';
import { accountAppearance } from '#lib/server/appearance.js';
import { hasUser, SESSION_COOKIE, validateSession } from '#lib/server/auth.js';
import { role } from '#lib/server/instance.js';
import { startApp } from '#lib/server/lifecycle.js';

export const init: ServerInit = async () => {
	if (!building) await startApp();
};

/**
 * Reachable without signing in. Peer endpoints check the pairing key themselves;
 * the ChatGPT sign-in callback only completes a sign-in started from this app;
 * card-frame media checks the daily key in its path. /import/cars is an empty
 * page that hands what the CARS bookmark sent to /api/cars (which needs sign-in).
 */
function isPublic(path: string) {
	return (
		path === '/api/health' ||
		path === '/import/cars' ||
		path.startsWith('/api/peer/') ||
		path.startsWith('/api/media/k/') ||
		path === '/manifest.webmanifest' ||
		path === '/offline' ||
		path === '/api/control/shutdown' ||
		path === '/auth/callback'
	);
}

/** Changes a standby (read-only copy) still accepts. */
function allowedOnStandby(path: string) {
	return (
		path.startsWith('/login') ||
		path.startsWith('/api/peer/') ||
		path === '/api/sync' ||
		path === '/api/system/quit' ||
		path === '/api/control/shutdown' ||
		path.startsWith('/settings/sync') ||
		path === '/api/auth/logout' ||
		path.startsWith('/setup')
	);
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function deny(isApi: boolean, status: number, message: string) {
	if (isApi) return Response.json({ error: message }, { status });
	return new Response(message, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** Pages carry the account's appearance settings, applied before the first paint (app.html). */
function withAppearance(resolve: Parameters<Handle>[0]['resolve'], event: Parameters<Handle>[0]['event']) {
	let appearance: ReturnType<typeof accountAppearance> | null = null;
	return resolve(event, {
		transformPageChunk: ({ html }) => {
			if (!html.includes('%medicus.')) return html;
			appearance ??= accountAppearance();
			const json = JSON.stringify(appearance).replace(/</g, '\\u003c');
			// Replacer functions: the script contains "$" signs that replace() would otherwise interpret.
			const a = appearance;
			const firstGuess = a.mode === 'pick' ? a.theme : a.mode === 'season' ? SEASON_THEMES[seasonOfDate(new Date())].day : a.lightTheme;
			return html
				.replace('%medicus.theme%', () => firstGuess)
				.replace('%medicus.appearance%', () => json)
				.replace('%medicus.boot%', () => BOOT_SCRIPT);
		}
	});
}

export const handle: Handle = async ({ event, resolve }) => {
	await startApp();
	const path = event.url.pathname;
	const isApi = path.startsWith('/api/');
	event.locals.session = validateSession(event.cookies.get(SESSION_COOKIE));
	event.locals.role = role();

	if (isPublic(path)) return withAppearance(resolve, event);

	// First run: nothing exists yet except the setup flow.
	if (!hasUser()) {
		if (path === '/setup' || path.startsWith('/setup/') || path.startsWith('/api/setup/')) return withAppearance(resolve, event);
		if (isApi) return deny(true, 401, 'Set up Medicus Vitae first.');
		redirect(303, '/setup');
	}
	if (path === '/setup' || path.startsWith('/setup/') || path.startsWith('/api/setup/')) {
		redirect(303, event.locals.session?.stage === 'full' ? '/' : '/login');
	}

	const session = event.locals.session;
	if (!session || session.stage !== 'full') {
		if (path === '/login') return withAppearance(resolve, event);
		if (isApi) return deny(true, 401, 'Sign in first.');
		const next = path === '/' ? '' : `?next=${encodeURIComponent(path + event.url.search)}`;
		redirect(303, `/login${next}`);
	}

	if (event.locals.role !== 'primary' && MUTATING.has(event.request.method) && !allowedOnStandby(path)) {
		return deny(
			isApi,
			409,
			event.locals.role === 'handing_off'
				? 'This device is handing over to the other device and is read-only right now.'
				: 'This device is a standby (a read-only copy). Make it primary in Settings › Backups & sync to make changes here.'
		);
	}

	return withAppearance(resolve, event);
};

export const handleError: HandleServerError = ({ kind, error }) => {
	if (kind === 'unknown') console.error(error);
};
