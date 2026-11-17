import { error, fail, redirect } from '@sveltejs/kit';
import { breakdown } from '#lib/server/fl-import.js';
import { deleteFullLength, getFullLength, PracticeError, updateFullLength } from '#lib/server/practice.js';
import { studyClock } from '#lib/server/settings.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, depends }) => {
	depends('app:fl');
	const fl = getFullLength(params.id);
	if (!fl) error(404, 'Full-length not found');
	return { ...fl, review: breakdown(params.id), today: studyClock().today };
};

function num(v: FormDataEntryValue | null) {
	const s = String(v ?? '').trim();
	return s === '' ? null : Number(s);
}

export const actions: Actions = {
	save: async ({ params, request }) => {
		const f = await request.formData();
		try {
			updateFullLength(params.id, {
				date: String(f.get('date') ?? ''),
				provider: String(f.get('provider') ?? ''),
				form: String(f.get('form') ?? ''),
				total: num(f.get('total')),
				cp: num(f.get('cp')),
				cars: num(f.get('cars')),
				bb: num(f.get('bb')),
				ps: num(f.get('ps')),
				notes: String(f.get('notes') ?? '')
			});
		} catch (err) {
			return fail(400, { error: err instanceof PracticeError ? err.message : 'Could not save.' });
		}
		return { saved: true };
	},
	delete: async ({ params }) => {
		deleteFullLength(params.id);
		redirect(303, '/progress');
	}
};
