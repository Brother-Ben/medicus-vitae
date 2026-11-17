import { fail, redirect } from '@sveltejs/kit';
import { createSession, hashPassword, hasUser, passwordProblem, setSessionCookie } from '#lib/server/auth.js';
import { isValidTimeZone } from '#lib/dates.js';
import { db } from '#lib/server/db/index.js';
import { user } from '#lib/server/db/schema.js';
import { PeerError, setUpAsStandby } from '#lib/server/peer.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	if (hasUser()) redirect(303, '/login');
	return {};
};

export const actions: Actions = {
	create: async ({ request, cookies, url }) => {
		if (hasUser()) redirect(303, '/login');
		const form = await request.formData();
		const displayName = String(form.get('displayName') ?? '').trim().slice(0, 60);
		const password = String(form.get('password') ?? '');
		const confirm = String(form.get('confirm') ?? '');
		const tz = String(form.get('timeZone') ?? 'UTC');
		const problem = passwordProblem(password);
		if (problem) return fail(400, { mode: 'new', displayName, error: problem });
		if (password !== confirm) return fail(400, { mode: 'new', displayName, error: 'The two passwords don’t match.' });
		const now = Date.now();
		db()
			.insert(user)
			.values({
				id: 1,
				displayName,
				passwordHash: await hashPassword(password),
				timeZone: isValidTimeZone(tz) ? tz : 'UTC',
				createdAt: now,
				updatedAt: now
			})
			.run();
		const { token, info } = createSession(request.headers.get('user-agent') ?? '');
		setSessionCookie(cookies, token, info, url.protocol === 'https:');
		redirect(303, '/welcome');
	},

	standby: async ({ request }) => {
		if (hasUser()) redirect(303, '/login');
		const form = await request.formData();
		const peerUrl = String(form.get('peerUrl') ?? '');
		const peerKey = String(form.get('peerKey') ?? '');
		try {
			await setUpAsStandby(peerUrl, peerKey);
		} catch (err) {
			const message = err instanceof PeerError || err instanceof Error ? err.message : String(err);
			return fail(400, { mode: 'standby', peerUrl, error: message });
		}
		redirect(303, '/login?standby=1');
	}
};
