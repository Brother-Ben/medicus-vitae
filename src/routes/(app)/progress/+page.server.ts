import { fail } from '@sveltejs/kit';
import { addDays } from '#lib/dates.js';
import {
	createFullLength,
	createPracticeSet,
	deletePracticeSet,
	listPracticeSets,
	PracticeError
} from '#lib/server/practice.js';
import { dailyGoalMinutes, studyClock, studySettings } from '#lib/server/settings.js';
import {
	cardTotals,
	fullLengthSummary,
	heatmap,
	mistakeReasons,
	PRACTICE_MIN,
	RECALL_MIN,
	retention,
	streak,
	studyTimeSeries
} from '#lib/server/stats.js';
import { sqlite } from '#lib/server/db/index.js';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url, depends }) => {
	depends('app:progress');
	const range = (['7', '30', 'all'].includes(url.searchParams.get('range') ?? '') ? url.searchParams.get('range') : '30') as '7' | '30' | 'all';
	const s = studySettings();
	const clock = studyClock(Date.now(), s);
	const days = range === '7' ? 7 : range === '30' ? 30 : 0;
	const fromDay = days ? addDays(clock.today, -(days - 1)) : undefined;
	const firstDay =
		(sqlite().prepare('SELECT min(study_day) AS d FROM study_session').get() as { d: string | null }).d ?? clock.today;
	const seriesDays = days || Math.min(365, Math.max(7, Math.round((Date.parse(clock.today) - Date.parse(firstDay)) / 86_400_000) + 1));
	const practiced = (
		sqlite().prepare('SELECT coalesce(sum(total), 0) AS n FROM practice_set WHERE deleted_at IS NULL AND date >= ?').get(fromDay ?? '0000') as {
			n: number;
		}
	).n;
	return {
		range,
		goal: s.goalScore,
		testDate: s.testDate,
		fl: fullLengthSummary(),
		heat: heatmap(clock),
		thresholds: { recall: RECALL_MIN, practice: PRACTICE_MIN },
		reasons: mistakeReasons(fromDay),
		series: studyTimeSeries(clock, seriesDays),
		dailyGoal: dailyGoalMinutes(s),
		retention: retention(clock, days || 3650),
		streak: streak(clock),
		totals: cardTotals(),
		reviewsInRange: (
			sqlite().prepare('SELECT count(*) AS n FROM review_event WHERE study_day >= ?').get(fromDay ?? '0000') as { n: number }
		).n,
		practiced,
		practiceSets: listPracticeSets(20),
		today: clock.today
	};
};

function num(v: FormDataEntryValue | null) {
	const s = String(v ?? '').trim();
	return s === '' ? null : Number(s);
}

export const actions: Actions = {
	fullLength: async ({ request }) => {
		const f = await request.formData();
		try {
			createFullLength({
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
			return fail(400, { form: 'fullLength', error: err instanceof PracticeError ? err.message : 'Could not save.' });
		}
		return { form: 'fullLength', ok: true };
	},
	practice: async ({ request }) => {
		const f = await request.formData();
		try {
			createPracticeSet({
				date: String(f.get('date') ?? ''),
				source: String(f.get('source') ?? ''),
				section: String(f.get('section') ?? '') || null,
				aamcCode: String(f.get('aamcCode') ?? '') || null,
				skillCode: String(f.get('skillCode') ?? '') || null,
				total: Number(f.get('total')),
				correct: Number(f.get('correct')),
				minutes: num(f.get('minutes')),
				notes: String(f.get('notes') ?? '')
			});
		} catch (err) {
			return fail(400, { form: 'practice', error: err instanceof PracticeError ? err.message : 'Could not save.' });
		}
		return { form: 'practice', ok: true };
	},
	deletePractice: async ({ request }) => {
		const f = await request.formData();
		deletePracticeSet(String(f.get('id') ?? ''));
		return { form: 'deletePractice', ok: true };
	}
};
