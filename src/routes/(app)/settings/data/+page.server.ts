import { config } from '#lib/server/config.js';
import { SCHEDULER_NAME } from '#lib/server/fsrs.js';
import { role } from '#lib/server/instance.js';
import { RESET_PARTS } from '#lib/server/reset.js';
import { cardTotals } from '#lib/server/stats.js';
import { sqlite } from '#lib/server/db/index.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	const count = (t: string, where = 'deleted_at IS NULL') =>
		(sqlite().prepare(`SELECT count(*) AS n FROM ${t}${where ? ` WHERE ${where}` : ''}`).get() as { n: number }).n;
	/** What each reset part holds now, in words, for the "Are you sure?" step. */
	const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`;
	const sizes: Record<string, string> = {
		books: plural(count('document', "role = 'book'"), 'book'),
		cards: `${plural(cardTotals().total, 'card')}, ${plural(count('review_event', ''), 'review')}`,
		notes: `${plural(count('annotation'), 'note')}, ${plural(count('document', "role = 'notes'"), 'notes PDF')}`,
		practice: `${plural(count('mistake'), 'mistake')}, ${plural(count('full_length'), 'full-length')}`,
		history: plural(count('study_session', ''), 'study stretch', 'study stretches'),
		tutor: plural(count('chat_thread'), 'conversation'),
		settings: 'your goals and preferences'
	};
	return {
		dataDir: config.dataDir,
		version: config.version,
		scheduler: SCHEDULER_NAME,
		role: role(),
		resetParts: RESET_PARTS.map((p) => ({ ...p, size: sizes[p.id] ?? '' })),
		counts: {
			books: count('document', "role = 'book'"),
			cards: cardTotals().total,
			reviews: count('review_event', ''),
			notes: count('annotation'),
			highlights: count('highlight'),
			mistakes: count('mistake'),
			fullLengths: count('full_length')
		}
	};
};
