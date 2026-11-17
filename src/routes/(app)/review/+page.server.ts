import { aiConnected } from '#lib/server/ai/providers.js';
import { nextLearningDue, nextReviewCard, queueCounts } from '#lib/server/cards.js';
import { getDocument } from '#lib/server/library.js';
import { getSessionPlan } from '#lib/server/planner.js';
import { listFullLengths, listPracticeSets } from '#lib/server/practice.js';
import { studyClock } from '#lib/server/settings.js';
import { secondsPerCard } from '#lib/server/stats.js';
import { CATEGORY_SHORT } from '#lib/aamc.js';
import { shortDate } from '#lib/dates.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url }) => {
	const aamc = url.searchParams.get('aamc');
	const docId = url.searchParams.get('doc');
	const limit = Number(url.searchParams.get('limit')) || null;
	const sessionId = url.searchParams.get('session');
	const itemId = url.searchParams.get('item');
	const deck = url.searchParams.get('deck');
	const onlyParam = url.searchParams.get('only');
	const only: 'due' | 'new' | null = onlyParam === 'due' || onlyParam === 'new' ? onlyParam : null;
	const filter = { aamcCode: aamc, documentId: docId, deck, only };
	const card = nextReviewCard([], filter);
	const doc = docId ? getDocument(docId) : null;
	const clock = studyClock();
	return {
		card,
		counts: queueCounts(clock, filter),
		nextLearningDue: card ? null : nextLearningDue(clock, filter),
		filter,
		filterLabel: aamc ? `${aamc} ${CATEGORY_SHORT[aamc] ?? ''}`.trim() : doc ? doc.title : deck ? deck.split('::').join(' › ') : null,
		limit,
		session: sessionId ? getSessionPlan(sessionId) : null,
		itemId,
		secondsPerCard: secondsPerCard().review,
		ai: aiConnected(),
		fullLengths: listFullLengths().map((f) => ({ id: f.id, label: `${f.provider}${f.form ? ` ${f.form}` : ''} · ${shortDate(f.date)}` })),
		practiceSets: listPracticeSets(30).map((p) => ({ id: p.id, label: `${p.source} · ${shortDate(p.date)} · ${p.correct}/${p.total}` }))
	};
};
