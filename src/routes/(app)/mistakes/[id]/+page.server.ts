import { error } from '@sveltejs/kit';
import { listFullLengths, listPracticeSets, mistakeDetail, PracticeError } from '#lib/server/practice.js';
import { studyClock } from '#lib/server/settings.js';
import { shortDate } from '#lib/dates.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, url, depends }) => {
	depends('app:mistake');
	let detail;
	try {
		detail = mistakeDetail(params.id);
	} catch (err) {
		if (err instanceof PracticeError) error(404, 'Mistake not found');
		throw err;
	}
	return {
		...detail,
		today: studyClock().today,
		sessionId: url.searchParams.get('session'),
		itemId: url.searchParams.get('item'),
		fullLengths: listFullLengths().map((f) => ({ id: f.id, label: `${f.provider}${f.form ? ` ${f.form}` : ''} · ${shortDate(f.date)}` })),
		practiceSets: listPracticeSets(30).map((p) => ({ id: p.id, label: `${p.source} · ${shortDate(p.date)} · ${p.correct}/${p.total}` }))
	};
};
