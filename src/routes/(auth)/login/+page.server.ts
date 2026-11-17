import { fail, redirect } from '@sveltejs/kit';
import { createSession, deleteSession, getUser, setSessionCookie, verifyPassword } from '#lib/server/auth.js';
import { role } from '#lib/server/instance.js';
import type { Actions, PageServerLoad } from './$types';

function safeNext(next: string | null) {
	return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.session?.stage === 'full') redirect(303, safeNext(url.searchParams.get('next')));
	return {
		next: safeNext(url.searchParams.get('next')),
		restored: url.searchParams.has('restored'),
		standby: url.searchParams.has('standby') || role() === 'standby'
	};
};

export const actions: Actions = {
	password: async ({ request, cookies, url, locals }) => {
		const form = await request.formData();
		const password = String(form.get('password') ?? '');
		const next = safeNext(String(form.get('next') ?? '/'));
		const u = getUser();
		if (!u || !(await verifyPassword(u.passwordHash, password))) {
			return fail(400, { error: 'That password isn’t right.' });
		}
		if (locals.session) deleteSession(locals.session.id);
		const { token, info } = createSession(request.headers.get('user-agent') ?? '');
		setSessionCookie(cookies, token, info, url.protocol === 'https:');
		redirect(303, next);
	}
};
