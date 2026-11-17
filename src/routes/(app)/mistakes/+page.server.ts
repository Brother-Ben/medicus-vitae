import { listFullLengths, listMistakes, listPracticeSets } from '#lib/server/practice.js';
import { studyClock } from '#lib/server/settings.js';
import { shortDate } from '#lib/dates.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url, depends }) => {
	depends('app:mistakes');
	const state = url.searchParams.get('state') ?? 'active';
	const aamc = url.searchParams.get('aamc');
	const reason = url.searchParams.get('reason');
	const fls = listFullLengths();
	const flNames = new Map(fls.map((f) => [f.id, `${f.provider}${f.form ? ` ${f.form}` : ''} · ${shortDate(f.date)}`]));
	const all = listMistakes({});
	return {
		state,
		aamc,
		reason,
		today: studyClock().today,
		mistakes: listMistakes({ state: state === 'all' ? null : state, aamcCode: aamc, reason }).map((m) => ({
			...m,
			fullLengthName: m.fullLengthId ? (flNames.get(m.fullLengthId) ?? 'Full-length') : null
		})),
		counts: {
			active: all.filter((m) => m.state !== 'resolved').length,
			resolved: all.filter((m) => m.state === 'resolved').length,
			retestDue: all.filter((m) => m.state === 'retest' && m.retestDue && m.retestDue <= studyClock().today).length,
			all: all.length
		},
		fullLengths: fls.map((f) => ({ id: f.id, label: flNames.get(f.id)! })),
		practiceSets: listPracticeSets(30).map((p) => ({ id: p.id, label: `${p.source} · ${shortDate(p.date)} · ${p.correct}/${p.total}` }))
	};
};
