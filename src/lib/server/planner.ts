import { and, asc, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import { CATEGORY_SHORT, reasonLabel } from '../aamc';
import { durationLabel, shortDate } from '../dates';
import {
	cleanSessionFocus,
	cleanTimer,
	extendTimer,
	nextPhase,
	pauseTimer,
	resumeTimer,
	sessionFocusFrom,
	startTimer,
	type SessionFocus,
	type TimerState
} from '../focus';
import { cardsScope, type PlanItem, type PlanItemType } from '../session';
import { cardDecks, queueCounts, type QueueFilter } from './cards';
import { db, sqlite } from './db';
import { document, mistake, sessionPlan } from './db/schema';
import { uuidv7 } from './ids';
import { documentSections, sectionAt } from './library';
import { focusPrefs, studyClock } from './settings';
import { dueSummary, secondsPerCard } from './stats';

// Study sessions (PLAN-07). "Suggest a plan" fills the chosen time by plain
// rules (due reviews first, then mistake retests and repairs, new cards and
// reading) and says why each item was picked; the owner can also build a plan
// by hand from specific decks, categories, chapters, mistakes and their own
// tasks. A session can run a focus timer (Pomodoro) with breaks, and items
// finish by themselves when the work is done.

export type { PlanItem, PlanItemType };

const RETEST_MIN = 4;
const REPAIR_MIN = 6;
const SECONDS_PER_PAGE = 150;

function minutes(seconds: number) {
	return Math.max(1, Math.round(seconds / 60));
}

export class PlanError extends Error {}

export interface BuildOptions {
	/** Keep the cards to one deck, category or book. */
	deck?: string | null;
	aamcCode?: string | null;
	cardDocId?: string | null;
	/** What to include (all by default). */
	include?: { reviews?: boolean; new?: boolean; mistakes?: boolean; reading?: boolean };
}

function cardFilter(o: BuildOptions): QueueFilter {
	return { deck: o.deck ?? null, aamcCode: o.aamcCode ?? null, documentId: o.cardDocId ?? null };
}

/** Suggests a plan that fits the time (see the file comment). */
export function buildSession(budgetMinutes: number, opts: BuildOptions = {}) {
	const budget = Math.max(5, Math.min(600, Math.round(budgetMinutes))) * 60;
	const clock = studyClock();
	const filter = cardFilter(opts);
	const scoped = !!(filter.deck || filter.aamcCode || filter.documentId);
	const counts = scoped ? queueCounts(clock, filter) : dueSummary(clock).counts;
	const inc = { reviews: true, new: true, mistakes: true, reading: true, ...(opts.include ?? {}) };
	const spc = secondsPerCard();
	const items: PlanItem[] = [];
	let left = budget;
	const scopeLabel = scoped ? ` in ${cardsScope({ deck: filter.deck, aamcCode: filter.aamcCode }, filter.documentId ? docTitle(filter.documentId) : null)}` : '';
	const scopeFields = { deck: filter.deck, aamcCode: filter.aamcCode, cardDocId: filter.documentId };

	const due = inc.reviews ? counts.learning + counts.review : 0;
	const retests = inc.mistakes
		? db()
				.select()
				.from(mistake)
				.where(and(isNull(mistake.deletedAt), eq(mistake.state, 'retest'), lte(mistake.retestDue, clock.today)))
				.orderBy(asc(mistake.retestDue))
				.all()
				.filter((m) => !filter.aamcCode || m.aamcCode === filter.aamcCode)
		: [];
	const repairs = inc.mistakes
		? db()
				.select()
				.from(mistake)
				.where(and(isNull(mistake.deletedAt), inArray(mistake.state, ['open', 'repair'])))
				.orderBy(desc(mistake.state), asc(mistake.createdAt))
				.all()
				.filter((m) => !filter.aamcCode || m.aamcCode === filter.aamcCode)
		: [];
	const reading =
		inc.reading && !filter.deck
			? (db()
					.select()
					.from(document)
					.where(and(eq(document.status, 'ready'), eq(document.role, 'book'), ...(filter.documentId ? [eq(document.id, filter.documentId)] : [])))
					.orderBy(desc(document.lastOpenedAt), desc(document.createdAt))
					.limit(1)
					.get() ?? null)
			: null;
	const freshAvailable = inc.new ? counts.new : 0;
	const otherWork = retests.length > 0 || repairs.length > 0 || freshAvailable > 0 || !!reading;

	if (due > 0) {
		const share = otherWork ? 0.6 : 1;
		const fit = Math.max(Math.min(due, 10), Math.floor((budget * share) / spc.review));
		const count = Math.min(due, fit);
		const secs = count * spc.review;
		left -= secs;
		const rest = due - count;
		items.push({
			id: uuidv7(),
			type: 'reviews',
			title: `Flashcard reviews${scopeLabel}`,
			detail: `${count} card${count === 1 ? '' : 's'} · about ${durationLabel(secs, 'long')}`,
			why:
				`${due} card${due === 1 ? ' is' : 's are'} due today${scopeLabel}. At your pace (about ${Math.round(spc.review)} seconds a card), ${count} fit${count === 1 ? 's' : ''} here. Due cards come first: putting them off makes them harder to remember.` +
				(rest > 0 ? ` The other ${rest} stay due for your next session.` : ''),
			minutes: minutes(secs),
			count,
			...scopeFields
		});
	}

	for (const m of retests.slice(0, 3)) {
		if (left < RETEST_MIN * 60) break;
		left -= RETEST_MIN * 60;
		const topic = m.aamcCode ? `${m.aamcCode} ${CATEGORY_SHORT[m.aamcCode] ?? ''}`.trim() : 'this idea';
		items.push({
			id: uuidv7(),
			type: 'retest',
			title: `Retest: ${m.summary || topic}`,
			detail: `${topic} · about ${RETEST_MIN} min`,
			why: `You fixed this mistake${m.retestDue ? ` and it was due for a retest on ${shortDate(m.retestDue)}` : ''}. Try a different question on the same idea to check the fix holds.`,
			minutes: RETEST_MIN,
			mistakeId: m.id
		});
	}

	for (const m of repairs.slice(0, 3)) {
		if (left < REPAIR_MIN * 60) break;
		left -= REPAIR_MIN * 60;
		const topic = m.aamcCode ? `${m.aamcCode} ${CATEGORY_SHORT[m.aamcCode] ?? ''}`.trim() : 'Uncategorized';
		items.push({
			id: uuidv7(),
			type: 'repair',
			title: `Fix: ${m.summary || topic}`,
			detail: `${topic} · ${reasonLabel(m.reason)} · about ${REPAIR_MIN} min`,
			why: `${m.state === 'repair' ? 'You started fixing this mistake.' : `Open since ${shortDate(m.studyDay)}.`} Go back to the passage behind it and explain the idea in your own words; a retest comes a few days later.`,
			minutes: REPAIR_MIN,
			mistakeId: m.id
		});
	}

	const allDueFit = !items.some((i) => i.type === 'reviews') || (items.find((i) => i.type === 'reviews')!.count ?? 0) >= due;
	if (freshAvailable > 0 && allDueFit && left >= 120) {
		const fit = Math.floor((left * (reading ? 0.5 : 1)) / spc.fresh);
		const count = Math.min(freshAvailable, Math.max(1, fit));
		const secs = count * spc.fresh;
		left -= secs;
		items.push({
			id: uuidv7(),
			type: 'new',
			title: `New cards${scopeLabel}`,
			detail: `${count} new card${count === 1 ? '' : 's'} · about ${durationLabel(secs, 'long')}`,
			why: `${freshAvailable} new card${freshAvailable === 1 ? ' is' : 's are'} waiting within today’s limit${scopeLabel}. Learning a few now keeps future review days even.`,
			minutes: minutes(secs),
			count,
			...scopeFields
		});
	}

	if (reading && left >= 300) {
		const start = Math.max(1, reading.lastPage ?? 1);
		const remainingPages = Math.max(1, (reading.pageCount ?? start) - start + 1);
		const pages = Math.max(1, Math.min(remainingPages, Math.floor(left / SECONDS_PER_PAGE)));
		const secs = pages * SECONDS_PER_PAGE;
		left -= secs;
		const section = sectionAt(reading.id, start);
		items.push({
			id: uuidv7(),
			type: 'reading',
			title: `Read: ${reading.title}`,
			detail: `Pages ${start}–${start + pages - 1}${section ? ` · ${section.title}` : ''} · about ${durationLabel(secs, 'long')}`,
			why: reading.lastPage
				? `Pick up where you stopped in ${reading.title} (page ${start}). About ${pages} page${pages === 1 ? '' : 's'} fit the time left, at roughly ${Math.round((SECONDS_PER_PAGE / 60) * 10) / 10} minutes a page.`
				: `${reading.title} is in your library and not started yet. About ${pages} page${pages === 1 ? '' : 's'} fit the time left.`,
			minutes: minutes(secs),
			documentId: reading.id,
			fromPage: start,
			toPage: start + pages - 1
		});
	}

	// Spare time and reviews still waiting: give them the rest.
	const reviews = items.find((i) => i.type === 'reviews');
	if (reviews && left > 120 && (reviews.count ?? 0) < due) {
		const more = Math.min(due - (reviews.count ?? 0), Math.floor(left / spc.review));
		if (more > 0) {
			reviews.count = (reviews.count ?? 0) + more;
			const secs = reviews.count * spc.review;
			reviews.minutes = minutes(secs);
			reviews.detail = `${reviews.count} card${reviews.count === 1 ? '' : 's'} · about ${durationLabel(secs, 'long')}`;
			left -= more * spc.review;
		}
	}

	const planned = items.reduce((a, i) => a + i.minutes, 0);
	let note: string | null = null;
	if (!items.length) {
		note = scoped
			? `Nothing is due${scopeLabel} right now. Add something below, or pick another deck.`
			: 'Nothing is due and there’s nothing open to fix. Add something below: a deck, a chapter or your own task.';
	} else if (planned < budget / 60 - 4) {
		note = `That covers everything waiting right now (about ${planned} of ${Math.round(budget / 60)} minutes). Add more below if you like.`;
	}
	return { budgetMinutes: Math.round(budget / 60), items, planned, note };
}

function docTitle(id: string) {
	return db().select({ t: document.title }).from(document).where(eq(document.id, id)).get()?.t ?? null;
}

// --------------------------------------------------------- the options

/** Everything the plan builder can offer: decks, categories, books with chapters, open mistakes. */
export function sessionOptions() {
	const clock = studyClock();
	const spc = secondsPerCard();
	const all = queueCounts(clock);
	const decks = cardDecks(clock).map((d) => ({
		deck: d.deck,
		label: d.label,
		depth: d.depth,
		due: d.learning + d.review,
		new: Math.min(d.new, all.newLimitLeft)
	}));
	const categories = (
		sqlite()
			.prepare(
				`SELECT n.aamc_code AS code,
				        sum(CASE WHEN c.state IN (1, 2, 3) AND c.due < ? THEN 1 ELSE 0 END) AS due,
				        sum(CASE WHEN c.state = 0 THEN 1 ELSE 0 END) AS fresh
				 FROM card c JOIN note n ON n.id = c.note_id
				 WHERE c.deleted_at IS NULL AND n.deleted_at IS NULL AND c.suspended = 0 AND n.aamc_code IS NOT NULL
				 GROUP BY n.aamc_code ORDER BY n.aamc_code`
			)
			.all(clock.dayEnd) as { code: string; due: number; fresh: number }[]
	).map((c) => ({ code: c.code, name: CATEGORY_SHORT[c.code] ?? c.code, due: c.due, new: Math.min(c.fresh, all.newLimitLeft) }));
	const books = db()
		.select()
		.from(document)
		.where(and(eq(document.status, 'ready'), eq(document.role, 'book')))
		.orderBy(desc(document.lastOpenedAt), desc(document.createdAt))
		.all()
		.map((d) => ({
			id: d.id,
			title: d.title,
			pageCount: d.pageCount ?? 1,
			lastPage: d.lastPage ?? 1,
			sections: documentSections(d.id).map((s) => ({ id: s.id, title: s.title, level: s.level, pageStart: s.pageStart, pageEnd: s.pageEnd }))
		}));
	const mistakes = db()
		.select()
		.from(mistake)
		.where(and(isNull(mistake.deletedAt), inArray(mistake.state, ['open', 'repair', 'retest'])))
		.orderBy(asc(mistake.createdAt))
		.all()
		.map((m) => ({
			id: m.id,
			state: m.state,
			summary: m.summary || (m.aamcCode ? `${m.aamcCode} ${CATEGORY_SHORT[m.aamcCode] ?? ''}`.trim() : 'Mistake'),
			aamcCode: m.aamcCode,
			reason: reasonLabel(m.reason),
			retestDue: m.retestDue,
			dueNow: m.state !== 'retest' || !m.retestDue || m.retestDue <= clock.today
		}));
	return {
		secondsPerCard: spc,
		secondsPerPage: SECONDS_PER_PAGE,
		retestMinutes: RETEST_MIN,
		repairMinutes: REPAIR_MIN,
		totals: { due: all.learning + all.review, new: all.new },
		decks,
		categories,
		books,
		mistakes,
		prefs: focusPrefs()
	};
}

// ----------------------------------------------------------- saving

function cleanItems(items: unknown[]): PlanItem[] {
	const types: PlanItemType[] = ['reviews', 'new', 'retest', 'repair', 'reading', 'custom'];
	return (items as Partial<PlanItem>[])
		.filter((i) => i && types.includes(i.type as PlanItemType))
		.slice(0, 30)
		.map((i) => ({
			id: typeof i.id === 'string' && i.id ? i.id : uuidv7(),
			type: i.type as PlanItemType,
			title: String(i.title ?? '').slice(0, 200) || 'Study',
			detail: String(i.detail ?? '').slice(0, 300),
			why: String(i.why ?? '').slice(0, 800),
			minutes: Math.max(1, Math.min(600, Math.round(Number(i.minutes) || 5))),
			...(i.count !== undefined ? { count: Math.max(1, Math.min(9999, Math.round(Number(i.count) || 1))) } : {}),
			...(i.deck ? { deck: String(i.deck) } : {}),
			...(i.aamcCode ? { aamcCode: String(i.aamcCode) } : {}),
			...(i.cardDocId ? { cardDocId: String(i.cardDocId) } : {}),
			...(i.mistakeId ? { mistakeId: String(i.mistakeId) } : {}),
			...(i.documentId ? { documentId: String(i.documentId) } : {}),
			...(i.fromPage ? { fromPage: Math.max(1, Math.round(Number(i.fromPage))) } : {}),
			...(i.toPage ? { toPage: Math.max(1, Math.round(Number(i.toPage))) } : {}),
			done: !!i.done
		}));
}

/**
 * Starts a session. With `focus`, the focus timer starts with the first item;
 * without it the session just counts the time.
 */
export function saveSessionPlan(budgetMinutes: number, items: PlanItem[], opts: { title?: string; focus?: Partial<SessionFocus> | null } = {}) {
	const clean = cleanItems(items).map((i) => ({ ...i, done: false }));
	if (!clean.length) throw new PlanError('Add something to work on first.');
	const id = uuidv7();
	const clock = studyClock();
	const focus = opts.focus ? cleanSessionFocus(opts.focus, sessionFocusFrom(focusPrefs())) : null;
	const timer = focus ? startTimer(focus, clock.now, clean[0].id) : null;
	// Only one session at a time: an earlier one still open today is ended.
	db()
		.update(sessionPlan)
		.set({ status: 'abandoned', completedAt: clock.now })
		.where(and(eq(sessionPlan.status, 'active'), eq(sessionPlan.studyDay, clock.today)))
		.run();
	db()
		.insert(sessionPlan)
		.values({
			id,
			budgetMinutes: Math.max(5, Math.min(600, Math.round(budgetMinutes) || 30)),
			items: clean,
			status: 'active',
			studyDay: clock.today,
			title: String(opts.title ?? '').trim().slice(0, 80),
			focus: focus as unknown as Record<string, unknown> | null,
			timer: (timer ?? { phase: 'done', currentItemId: clean[0].id }) as unknown as Record<string, unknown>,
			createdAt: clock.now,
			startedAt: clock.now
		})
		.run();
	return id;
}

export function getSessionPlan(id: string) {
	const row = db().select().from(sessionPlan).where(eq(sessionPlan.id, id)).get();
	if (!row) return null;
	return shape(row);
}

function shape(row: typeof sessionPlan.$inferSelect) {
	const items = cleanItems(row.items as unknown[]);
	const focus = row.focus ? cleanSessionFocus(row.focus) : null;
	const timer = focus ? cleanTimer(row.timer) : null;
	const raw = (row.timer ?? {}) as { currentItemId?: unknown };
	const currentItemId = timer?.currentItemId ?? (typeof raw.currentItemId === 'string' ? raw.currentItemId : null);
	const current = items.find((i) => i.id === currentItemId && !i.done) ?? items.find((i) => !i.done) ?? null;
	return { ...row, items, focus, timer, currentItemId: current?.id ?? null };
}

export type SessionView = NonNullable<ReturnType<typeof getSessionPlan>>;

function writeItems(id: string, items: PlanItem[], extra: Partial<typeof sessionPlan.$inferInsert> = {}) {
	db().update(sessionPlan).set({ items, ...extra }).where(eq(sessionPlan.id, id)).run();
}

function writeTimer(id: string, timer: Record<string, unknown>) {
	db().update(sessionPlan).set({ timer }).where(eq(sessionPlan.id, id)).run();
}

/** The item after this one, or the first open item. */
function nextOpen(items: PlanItem[], after: string | null) {
	const i = after ? items.findIndex((x) => x.id === after) : -1;
	return items.slice(i + 1).find((x) => !x.done) ?? items.find((x) => !x.done) ?? null;
}

export function setSessionItemDone(id: string, itemId: string, done: boolean) {
	const plan = getSessionPlan(id);
	if (!plan) return;
	const items = plan.items.map((i) => (i.id === itemId ? { ...i, done } : i));
	const allDone = items.every((i) => i.done);
	// Finishing the item being worked on moves on to the next one.
	const current = done && plan.currentItemId === itemId ? (nextOpen(items, itemId)?.id ?? null) : plan.currentItemId;
	writeItems(id, items, {
		status: allDone ? 'done' : plan.status === 'done' ? 'active' : plan.status,
		completedAt: allDone ? Date.now() : null,
		timer: { ...(plan.timer ?? { phase: 'done' }), currentItemId: current } as unknown as Record<string, unknown>
	});
}

export function setCurrentItem(id: string, itemId: string) {
	const plan = getSessionPlan(id);
	if (!plan || !plan.items.some((i) => i.id === itemId)) return;
	const base = (plan.timer ?? { phase: 'done' }) as unknown as Record<string, unknown>;
	writeTimer(id, { ...base, currentItemId: itemId });
}

/** Edit a running session: add items, remove one, move one, or change the planned length. */
export function editSession(
	id: string,
	edit: { add?: PlanItem[]; remove?: string; move?: { itemId: string; by: -1 | 1 }; budgetMinutes?: number; title?: string; focus?: Partial<SessionFocus> | null }
) {
	const plan = getSessionPlan(id);
	if (!plan) throw new PlanError('Session not found.');
	let items = [...plan.items];
	if (edit.add?.length) items = [...items, ...cleanItems(edit.add).map((i) => ({ ...i, done: false }))].slice(0, 30);
	if (edit.remove) items = items.filter((i) => i.id !== edit.remove);
	if (edit.move) {
		const i = items.findIndex((x) => x.id === edit.move!.itemId);
		const j = i + edit.move.by;
		if (i >= 0 && j >= 0 && j < items.length) [items[i], items[j]] = [items[j], items[i]];
	}
	const extra: Partial<typeof sessionPlan.$inferInsert> = {};
	if (edit.budgetMinutes !== undefined) extra.budgetMinutes = Math.max(5, Math.min(600, Math.round(edit.budgetMinutes)));
	if (edit.title !== undefined) extra.title = edit.title.trim().slice(0, 80);
	if (edit.focus !== undefined) {
		if (edit.focus === null) {
			extra.focus = null;
			extra.timer = { phase: 'done', currentItemId: plan.currentItemId };
		} else {
			const focus = cleanSessionFocus(edit.focus, plan.focus ?? sessionFocusFrom(focusPrefs()));
			extra.focus = focus as unknown as Record<string, unknown>;
			if (!plan.timer) extra.timer = startTimer(focus, Date.now(), plan.currentItemId) as unknown as Record<string, unknown>;
		}
	}
	if (!items.length) throw new PlanError('A session needs at least one item. End the session instead.');
	const allDone = items.every((i) => i.done);
	writeItems(id, items, { ...extra, status: allDone ? 'done' : 'active', completedAt: allDone ? Date.now() : null });
	return getSessionPlan(id);
}

export type TimerAction = 'pause' | 'resume' | 'skip' | 'next-phase' | 'extend' | 'start';

/**
 * Moves the focus timer: pause/resume, start a phase that is waiting, skip to
 * the next phase, add minutes, or (when time is up) go on to the next phase.
 */
export function timerAction(id: string, action: TimerAction, minutesToAdd = 5): TimerState | null {
	const plan = getSessionPlan(id);
	if (!plan || !plan.focus) throw new PlanError('This session has no focus timer.');
	const now = Date.now();
	let t = plan.timer ?? startTimer(plan.focus, now, plan.currentItemId);
	switch (action) {
		case 'pause':
			t = pauseTimer(t, now);
			break;
		case 'resume':
			t = resumeTimer(t, now);
			break;
		case 'extend':
			t = extendTimer(t, Math.max(-60, Math.min(60, minutesToAdd)));
			break;
		case 'start':
			if (t.phase === 'ready-focus' || t.phase === 'ready-break') t = nextPhase(t, plan.focus, now);
			else if (t.pausedAt) t = resumeTimer(t, now);
			break;
		case 'skip':
			t = nextPhase(resumeTimer(t, now), plan.focus, now);
			break;
		case 'next-phase': {
			// Only when the time is really up (a second's slack for clocks), so two tabs can't skip a phase.
			const left = (t.phaseSeconds * 1000 - (now - t.phaseStartedAt - t.pausedMs - (t.pausedAt ? now - t.pausedAt : 0))) / 1000;
			if ((t.phase === 'focus' || t.phase === 'break') && !t.pausedAt && left <= 1.5) t = nextPhase(t, plan.focus, now);
			break;
		}
	}
	t = { ...t, currentItemId: plan.currentItemId };
	writeTimer(id, t as unknown as Record<string, unknown>);
	return t;
}

export function endSession(id: string) {
	const plan = getSessionPlan(id);
	if (!plan) return;
	const allDone = plan.items.every((i) => i.done);
	db()
		.update(sessionPlan)
		.set({ status: allDone ? 'done' : 'abandoned', completedAt: Date.now() })
		.where(eq(sessionPlan.id, id))
		.run();
}

export function activeSession() {
	const clock = studyClock();
	const row = db()
		.select()
		.from(sessionPlan)
		.where(and(eq(sessionPlan.status, 'active'), eq(sessionPlan.studyDay, clock.today)))
		.orderBy(desc(sessionPlan.createdAt))
		.limit(1)
		.get();
	return row ? shape(row) : null;
}

/** Recent sessions for Today's history. */
export function recentSessions(limit = 8) {
	return db()
		.select()
		.from(sessionPlan)
		.orderBy(desc(sessionPlan.createdAt))
		.limit(limit)
		.all()
		.map((r) => {
			const s = shape(r);
			return {
				id: s.id,
				title: s.title || `${s.budgetMinutes}-minute session`,
				studyDay: s.studyDay,
				status: s.status,
				done: s.items.filter((i) => i.done).length,
				total: s.items.length,
				focusedSeconds: s.timer?.focusedSeconds ?? 0,
				rounds: s.timer?.rounds ?? 0
			};
		});
}

// ------------------------------------------------ finishing by itself

/**
 * Marks matching items of today's session done: reading when the owner reaches
 * the last planned page, a mistake item when the mistake moves on.
 */
export function completeSessionWork(work: { readingDoc: string; page: number } | { mistakeId: string }) {
	const plan = activeSession();
	if (!plan) return;
	for (const item of plan.items) {
		if (item.done) continue;
		const hit =
			'readingDoc' in work
				? item.type === 'reading' && item.documentId === work.readingDoc && work.page >= (item.toPage ?? item.fromPage ?? 1)
				: (item.type === 'repair' || item.type === 'retest') && item.mistakeId === work.mistakeId;
		if (hit) setSessionItemDone(plan.id, item.id, true);
	}
}
