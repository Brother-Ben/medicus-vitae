import { redirect } from '@sveltejs/kit';
import { desc, eq } from 'drizzle-orm';
import { db } from '#lib/server/db/index.js';
import { aiSummary } from '#lib/server/db/schema.js';
import { pendingCount } from '#lib/server/ai/generate.js';
import { latestInsight } from '#lib/server/ai/insights.js';
import { aiConnected } from '#lib/server/ai/providers.js';
import { getUser } from '#lib/server/auth.js';
import { carsToday } from '#lib/server/cars.js';
import { reviewQueue, studyHistory, whatToWorkOn } from '#lib/server/dashboard.js';
import { continueReading, listDocuments, sectionAt } from '#lib/server/library.js';
import { booksForNotes } from '#lib/server/notes.js';
import { activeSession, recentSessions } from '#lib/server/planner.js';
import { studyClock, studySettings } from '#lib/server/settings.js';
import { dueSummary, focusAreas, forecast, fullLengthSummary, retention, streak, weekSummary } from '#lib/server/stats.js';
import { cardTotals } from '#lib/server/stats.js';
import type { PageServerLoad } from './$types';

function greeting(ms: number, timeZone: string) {
	const hour = Number(new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', hourCycle: 'h23' }).format(ms));
	if (hour < 5) return 'Up late';
	if (hour < 12) return 'Good morning';
	if (hour < 18) return 'Good afternoon';
	return 'Good evening';
}

export const load: PageServerLoad = ({ depends }) => {
	depends('app:today');
	const u = getUser();
	if (u && !u.onboardedAt) redirect(303, '/welcome');
	const s = studySettings();
	const clock = studyClock(Date.now(), s);
	const reading = continueReading();
	const docs = listDocuments();
	const fl = fullLengthSummary();
	const ret = retention(clock, 30);
	const ai = aiConnected();
	const readingDoc = reading ? docs.find((d) => d.id === reading.id) : null;
	return {
		today: clock.today,
		calendarDate: new Intl.DateTimeFormat('en-US', { timeZone: s.timeZone, weekday: 'long', month: 'long', day: 'numeric' }).format(clock.now),
		greeting: greeting(clock.now, s.timeZone),
		name: s.displayName,
		streak: streak(clock),
		due: dueSummary(clock),
		week: weekSummary(clock),
		retention: ret,
		desiredRetention: s.desiredRetention,
		lastFullLength: fl.latest ? { total: fl.latest.total, date: fl.latest.date, delta: fl.delta, provider: fl.latest.provider } : null,
		focus: focusAreas(),
		forecast: forecast(clock, 7),
		history: studyHistory(clock, 14),
		workOn: whatToWorkOn(clock),
		queue: reviewQueue(clock),
		sessions: recentSessions(5),
		reading: reading
			? {
					id: reading.id,
					title: reading.title,
					page: reading.lastPage ?? 1,
					pageCount: reading.pageCount ?? 0,
					/** Marked done (chapters), not pages opened. */
					progressPct: readingDoc?.done.pct ?? 0,
					section: sectionAt(reading.id, reading.lastPage ?? 1)?.title ?? null,
					highlights: readingDoc?.highlights ?? 0,
					cards: readingDoc?.cards ?? 0
				}
			: null,
		cars: carsToday(clock),
		hasBooks: docs.length > 0,
		processing: docs.filter((d) => d.status === 'queued' || d.status === 'processing').length,
		totals: cardTotals(),
		activeSession: activeSession(),
		// The AI coach and "Ask the tutor" appear only with an AI service connected.
		ai,
		insights: ai
			? { recap: latestInsight('recap'), suggest: latestInsight('suggest'), mistakes: latestInsight('mistakes'), chapter: latestChapter() }
			: null,
		books: ai ? booksForNotes().map((b) => ({ id: b.id, title: b.title, sections: b.sections.map((x) => ({ id: x.id, title: x.title, level: x.level, pageStart: x.pageStart, pageEnd: x.pageEnd })) })) : [],
		approvals: pendingCount()
	};
};

/** The newest chapter summary, whatever chapter it was for. */
function latestChapter() {
	const row = db().select().from(aiSummary).where(eq(aiSummary.kind, 'chapter')).orderBy(desc(aiSummary.createdAt)).limit(1).get();
	return row ? latestInsight('chapter', row.scope) : null;
}
