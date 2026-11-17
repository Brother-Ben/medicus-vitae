import { fail } from '@sveltejs/kit';
import { SettingsError, studySettings, updateStudySettings } from '#lib/server/settings.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ settings: studySettings() });

function num(v: FormDataEntryValue | null): number | null {
	const s = String(v ?? '').trim();
	if (!s) return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

export const actions: Actions = {
	save: async ({ request }) => {
		const f = await request.formData();
		try {
			updateStudySettings({
				displayName: String(f.get('displayName') ?? ''),
				testDate: String(f.get('testDate') ?? '') || null,
				goalScore: num(f.get('goalScore')),
				weeklyHours: num(f.get('weeklyHours')),
				studyDays: f.getAll('studyDays').map(Number),
				dayStartHour: num(f.get('dayStartHour')) ?? 4,
				timeZone: String(f.get('timeZone') ?? 'UTC'),
				newCardsPerDay: num(f.get('newCardsPerDay')) ?? 20,
				desiredRetention: (num(f.get('desiredRetention')) ?? 90) / 100,
				leechThreshold: num(f.get('leechThreshold')) ?? 8
			});
		} catch (err) {
			return fail(400, { error: err instanceof SettingsError ? err.message : 'Could not save.' });
		}
		return { saved: true };
	}
};
