import { fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { deleteAllSessions, getUser, hashPassword, passwordProblem, verifyPassword } from '#lib/server/auth.js';
import { db } from '#lib/server/db/index.js';
import { user } from '#lib/server/db/schema.js';
import type { Actions } from './$types';

export const actions: Actions = {
	password: async ({ request, locals }) => {
		const f = await request.formData();
		const current = String(f.get('current') ?? '');
		const next = String(f.get('next') ?? '');
		const confirm = String(f.get('confirm') ?? '');
		const u = getUser();
		if (!u || !(await verifyPassword(u.passwordHash, current))) {
			return fail(400, { form: 'password', error: 'Your current password isn’t right.' });
		}
		const problem = passwordProblem(next);
		if (problem) return fail(400, { form: 'password', error: problem });
		if (next !== confirm) return fail(400, { form: 'password', error: 'The new passwords don’t match.' });
		db()
			.update(user)
			.set({ passwordHash: await hashPassword(next), updatedAt: Date.now() })
			.where(eq(user.id, 1))
			.run();
		// Other browsers signed in with the old password are signed out.
		deleteAllSessions(locals.session?.id);
		return { form: 'password', ok: true };
	}
};
