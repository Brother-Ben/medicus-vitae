import { fail, redirect } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { user, type Baseline } from '#lib/server/db/schema.js';
import { SettingsError, studySettings, updateStudySettings } from '#lib/server/settings.js';
import type { Actions, PageServerLoad } from './$types';

const STEPS = ['target', 'baseline', 'content', 'ai'] as const;

export const load: PageServerLoad = ({ url }) => {
	const requested = url.searchParams.get('step');
	const step = (STEPS as readonly string[]).includes(requested ?? '') ? (requested as (typeof STEPS)[number]) : 'target';
	return { step, steps: STEPS, settings: studySettings() };
};

function num(v: FormDataEntryValue | null): number | null {
	const s = String(v ?? '').trim();
	if (!s) return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

export const actions: Actions = {
	target: async ({ request }) => {
		const f = await request.formData();
		try {
			updateStudySettings({
				testDate: String(f.get('testDate') ?? '') || null,
				goalScore: num(f.get('goalScore')),
				weeklyHours: num(f.get('weeklyHours')),
				studyDays: f.getAll('studyDays').map(Number),
				dayStartHour: num(f.get('dayStartHour')) ?? 4,
				timeZone: String(f.get('timeZone') ?? 'UTC')
			});
		} catch (err) {
			return fail(400, { error: err instanceof SettingsError ? err.message : 'Could not save.' });
		}
		redirect(303, '/welcome?step=baseline');
	},

	baseline: async ({ request }) => {
		const f = await request.formData();
		const kind = String(f.get('kind') ?? '');
		let baseline: Baseline | null = null;
		if (kind === 'diagnostic') {
			const section = (k: string) => {
				const n = num(f.get(k));
				if (n !== null && (n < 118 || n > 132)) throw new SettingsError('Section scores are between 118 and 132.');
				return n;
			};
			try {
				const cp = section('cp');
				const cars = section('cars');
				const bb = section('bb');
				const ps = section('ps');
				let total = num(f.get('total'));
				if (cp && cars && bb && ps) total = cp + cars + bb + ps;
				if (total !== null && (total < 472 || total > 528)) throw new SettingsError('Total scores are between 472 and 528.');
				baseline = { kind: 'diagnostic', date: String(f.get('date') ?? '') || undefined, total, cp, cars, bb, ps };
			} catch (err) {
				return fail(400, { error: err instanceof SettingsError ? err.message : 'Check the scores.' });
			}
		} else if (kind === 'confidence') {
			const c = (k: string) => {
				const n = num(f.get(k));
				return n && n >= 1 && n <= 5 ? n : null;
			};
			baseline = { kind: 'confidence', cp: c('cp'), cars: c('cars'), bb: c('bb'), ps: c('ps') };
		}
		updateStudySettings({ baseline });
		redirect(303, '/welcome?step=content');
	},

	finish: async ({ request }) => {
		const next = String((await request.formData()).get('next') ?? '');
		db().update(user).set({ onboardedAt: Date.now() }).where(eq(user.id, 1)).run();
		redirect(303, next === 'ai' ? '/settings/ai' : next === 'anki' ? '/cards/import' : '/');
	}
};
