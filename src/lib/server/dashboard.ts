import { CATEGORY_SHORT, reasonLabel } from '../aamc';
import { addDays, diffDays, durationLabel, shortDate } from '../dates';
import { cardDecks, leechCount, queueCounts } from './cards';
import { sqlite } from './db';
import { continueReading, sectionAt } from './library';
import { recentSessions } from './planner';
import { listMistakes } from './practice';
import { studyClock, studySettings, type StudyClock } from './settings';
import { focusAreas, fullLengthSummary, retention, streak, weekSummary } from './stats';

// What Today shows beyond the basics: recent history, a short list of what to
// work on (plain rules, each with a reason and one tap to start), what needs
// reviewing, and a compact summary of everything for the AI coach.

function all<T>(q: string, ...p: unknown[]): T[] {
	return sqlite().prepare(q).all(...p) as T[];
}

/** Study time and reviews per day, oldest first. */
export function studyHistory(clock: StudyClock = studyClock(), days = 14) {
	const from = addDays(clock.today, -(days - 1));
	const time = new Map(all<{ d: string; s: number }>('SELECT study_day AS d, sum(seconds) AS s FROM study_session WHERE study_day >= ? GROUP BY study_day', from).map((r) => [r.d, r.s]));
	const reviews = new Map(
		all<{ d: string; n: number; passed: number }>('SELECT study_day AS d, count(*) AS n, sum(rating >= 2) AS passed FROM review_event WHERE study_day >= ? GROUP BY study_day', from).map((r) => [r.d, r])
	);
	return Array.from({ length: days }, (_, i) => {
		const day = addDays(from, i);
		const r = reviews.get(day);
		return { day, seconds: time.get(day) ?? 0, reviews: r?.n ?? 0, passed: r?.passed ?? 0 };
	});
}

export interface WorkItem {
	id: string;
	icon: string;
	title: string;
	detail: string;
	/** Where "Start" goes. */
	href: string;
	/** What a session made from this would focus on. */
	focus?: { deck?: string; aamcCode?: string };
	tone?: 'warn';
}

/** A short, ordered list of what to do next, from plain rules. */
export function whatToWorkOn(clock: StudyClock = studyClock()): WorkItem[] {
	const out: WorkItem[] = [];
	const counts = queueCounts(clock);
	const due = counts.learning + counts.review;
	if (due > 0) {
		const decks = cardDecks(clock)
			.filter((d) => d.depth === 0 && d.learning + d.review > 0)
			.sort((a, b) => b.learning + b.review - (a.learning + a.review));
		out.push({
			id: 'due',
			icon: 'cards',
			title: `Review ${due} due card${due === 1 ? '' : 's'}`,
			detail: decks.length ? `Most in ${decks.slice(0, 2).map((d) => `${d.label} (${d.learning + d.review})`).join(', ')}. Due cards are easiest to keep when you do them today.` : 'Due cards are easiest to keep when you do them today.',
			href: '/review?only=due'
		});
	}
	const s = studySettings();
	const mistakes = listMistakes({ state: 'active' });
	const retests = mistakes.filter((m) => m.state === 'retest' && m.retestDue && m.retestDue <= clock.today);
	if (retests.length) {
		out.push({
			id: 'retest',
			icon: 'target',
			title: `Retest ${retests.length} fixed mistake${retests.length === 1 ? '' : 's'}`,
			detail: 'Try a different question on the same idea to check the fix holds.',
			href: `/mistakes/${retests[0].id}`
		});
	}
	const open = mistakes.filter((m) => m.state === 'open' || m.state === 'repair');
	if (open.length) {
		out.push({
			id: 'repair',
			icon: 'journal',
			title: `Fix ${open.length} open mistake${open.length === 1 ? '' : 's'}`,
			detail: `Oldest: ${open[open.length - 1]?.summary || 'a mistake'} (${reasonLabel(open[open.length - 1]?.reason ?? '')}).`,
			href: '/mistakes'
		});
	}
	for (const f of focusAreas().slice(0, 2)) {
		out.push({
			id: `weak-${f.code}`,
			icon: 'chart',
			title: `Strengthen ${f.code} ${CATEGORY_SHORT[f.code] ?? f.name}`,
			detail: `${f.value === null ? f.detail : `${Math.round(f.value * 100)}%`}: one of your weakest areas lately. Review its cards or reread its chapter.`,
			href: `/review?aamc=${encodeURIComponent(f.code)}`,
			focus: { aamcCode: f.code },
			tone: 'warn'
		});
	}
	const leeches = leechCount();
	if (leeches) {
		out.push({
			id: 'leech',
			icon: 'alert',
			title: `Rewrite ${leeches} leech card${leeches === 1 ? '' : 's'}`,
			detail: 'Cards you keep forgetting. Splitting or rewording them usually fixes it.',
			href: '/cards?state=leech'
		});
	}
	const reading = continueReading();
	if (reading && reading.pageCount && (reading.lastPage ?? 1) < reading.pageCount) {
		const sec = sectionAt(reading.id, reading.lastPage ?? 1);
		out.push({
			id: 'read',
			icon: 'book',
			title: `Keep reading ${reading.title}`,
			detail: `Page ${reading.lastPage ?? 1} of ${reading.pageCount}${sec ? ` · ${sec.title}` : ''}.`,
			href: `/library/${reading.id}/read?page=${reading.lastPage ?? 1}`
		});
	}
	const fl = fullLengthSummary();
	if (s.testDate) {
		const left = diffDays(clock.today, s.testDate);
		const sinceFl = fl.latest ? diffDays(fl.latest.date, clock.today) : null;
		if (left > 0 && left <= 70 && (sinceFl === null || sinceFl >= 14)) {
			out.push({
				id: 'fl',
				icon: 'flag',
				title: 'Take a full-length practice test',
				detail: `${left} days to test day${sinceFl === null ? ' and no full-length logged yet' : `; your last one was ${sinceFl} days ago`}. Log it under Progress when you’re done.`,
				href: '/progress'
			});
		}
	}
	if (counts.new > 0 && due === 0) {
		out.push({
			id: 'new',
			icon: 'plus',
			title: `Learn ${counts.new} new card${counts.new === 1 ? '' : 's'}`,
			detail: 'All caught up on reviews, so it’s a good time for new ones.',
			href: '/review?only=new'
		});
	}
	return out.slice(0, 6);
}

/** What's waiting: due cards per deck, retests, leeches. */
export function reviewQueue(clock: StudyClock = studyClock()) {
	const counts = queueCounts(clock);
	const decks = cardDecks(clock)
		.filter((d) => d.learning + d.review + d.new > 0)
		.sort((a, b) => b.learning + b.review - (a.learning + a.review) || a.deck.localeCompare(b.deck))
		.slice(0, 6)
		.map((d) => ({ deck: d.deck, label: d.deck.split('::').join(' › '), due: d.learning + d.review, new: Math.min(d.new, counts.newLimitLeft) }));
	const ungrouped = all<{ n: number }>(
		`SELECT count(*) AS n FROM card c JOIN note n ON n.id = c.note_id
		 WHERE c.deleted_at IS NULL AND n.deleted_at IS NULL AND c.suspended = 0 AND c.deck IS NULL
		 AND ((c.state = 2 AND c.due < ?) OR (c.state IN (1, 3) AND c.due <= ?))`,
		clock.dayEnd,
		clock.now + 20 * 60_000
	)[0]?.n ?? 0;
	const mistakes = listMistakes({ state: 'active' });
	return {
		counts,
		decks,
		madeHere: ungrouped,
		retests: mistakes.filter((m) => m.state === 'retest' && m.retestDue && m.retestDue <= clock.today).length,
		openMistakes: mistakes.filter((m) => m.state !== 'retest').length,
		leeches: leechCount()
	};
}

/** Everything the AI coach needs, small and plain. */
export function studySnapshot(clock: StudyClock = studyClock()) {
	const s = studySettings();
	const hist = studyHistory(clock, 28);
	const lastWeek = hist.slice(-7);
	const weekBefore = hist.slice(-14, -7);
	const sum = (xs: typeof hist, k: 'seconds' | 'reviews' | 'passed') => xs.reduce((a, x) => a + x[k], 0);
	const fl = fullLengthSummary();
	const mistakes = listMistakes({});
	const counts = queueCounts(clock);
	const byReason = new Map<string, number>();
	const byCat = new Map<string, number>();
	for (const m of mistakes) {
		byReason.set(reasonLabel(m.reason), (byReason.get(reasonLabel(m.reason)) ?? 0) + 1);
		if (m.aamcCode) byCat.set(m.aamcCode, (byCat.get(m.aamcCode) ?? 0) + 1);
	}
	return {
		today: clock.today,
		testDate: s.testDate,
		daysToTest: s.testDate ? diffDays(clock.today, s.testDate) : null,
		goalScore: s.goalScore,
		weeklyGoalHours: s.weeklyHours,
		streakDays: streak(clock).current,
		thisWeek: { studied: durationLabel(weekSummary(clock).seconds, 'long') },
		last7Days: { studied: durationLabel(sum(lastWeek, 'seconds'), 'long'), reviews: sum(lastWeek, 'reviews'), recallPct: sum(lastWeek, 'reviews') ? Math.round((sum(lastWeek, 'passed') / sum(lastWeek, 'reviews')) * 100) : null, daysStudied: lastWeek.filter((d) => d.seconds > 300 || d.reviews > 0).length },
		previous7Days: { studied: durationLabel(sum(weekBefore, 'seconds'), 'long'), reviews: sum(weekBefore, 'reviews'), daysStudied: weekBefore.filter((d) => d.seconds > 300 || d.reviews > 0).length },
		cardRetention30d: retention(clock, 30).rate,
		dueNow: { reviews: counts.learning + counts.review, newLeftToday: counts.new },
		weakAreas: focusAreas().map((f) => ({ code: f.code, name: CATEGORY_SHORT[f.code] ?? f.name, score: f.value === null ? null : Math.round(f.value * 100), evidence: f.detail })),
		fullLengths: fl.list.slice(-5).map((x) => ({ date: x.date, provider: x.provider, total: x.total, cp: x.cp, cars: x.cars, bb: x.bb, ps: x.ps })),
		mistakes: {
			open: mistakes.filter((m) => m.state !== 'resolved').length,
			resolved: mistakes.filter((m) => m.state === 'resolved').length,
			byReason: Object.fromEntries(byReason),
			byCategory: Object.fromEntries([...byCat].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => [`${c} ${CATEGORY_SHORT[c] ?? ''}`.trim(), n])),
			recent: mistakes.slice(0, 12).map((m) => ({ when: shortDate(m.studyDay), category: m.aamcCode, reason: reasonLabel(m.reason), summary: m.summary.slice(0, 160), state: m.state }))
		},
		recentSessions: recentSessions(5).map((r) => ({ day: r.studyDay, title: r.title, done: `${r.done}/${r.total}`, focused: durationLabel(r.focusedSeconds, 'long') })),
		reading: (() => {
			const r = continueReading();
			return r ? { book: r.title, page: r.lastPage, of: r.pageCount } : null;
		})()
	};
}
