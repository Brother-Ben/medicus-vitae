import { CARS_SKILL_CODES, CATEGORIES, CATEGORY_SHORT, MISTAKE_REASONS, SECTIONS, type SectionCode } from '../aamc';
import { addDays, diffDays, studyDayOf, weekdayOf } from '../dates';
import { queueCounts, type QueueCounts } from './cards';
import { sqlite } from './db';
import { listFullLengths } from './practice';
import { dailyGoalMinutes, studyClock, studySettings, type StudyClock } from './settings';

// Tracking (TRK-01, TRK-02) and the review forecast (CARD-06). Evidence types are
// kept apart: flashcard recall, applied practice and full-length results are
// never pooled into one score, and thin evidence shows as "not enough data".

export const RECALL_MIN = 20;
export const PRACTICE_MIN = 10;
const EVIDENCE_WINDOW_DAYS = 60;

function all<T>(q: string, ...params: unknown[]): T[] {
	return sqlite().prepare(q).all(...params) as T[];
}

function one<T>(q: string, ...params: unknown[]): T {
	return sqlite().prepare(q).get(...params) as T;
}

// --------------------------------------------------------- study days

/** Days with real study: any review, 5+ minutes of tracked time, or logged practice. */
export function activeDays(): Set<string> {
	const days = new Set<string>();
	for (const r of all<{ d: string }>('SELECT DISTINCT study_day AS d FROM review_event')) days.add(r.d);
	for (const r of all<{ d: string }>('SELECT study_day AS d FROM study_session GROUP BY study_day HAVING sum(seconds) >= 300')) {
		days.add(r.d);
	}
	for (const r of all<{ d: string }>('SELECT DISTINCT study_day AS d FROM attempt')) days.add(r.d);
	for (const r of all<{ d: string }>('SELECT DISTINCT study_day AS d FROM mistake WHERE deleted_at IS NULL')) days.add(r.d);
	for (const r of all<{ d: string }>('SELECT DISTINCT date AS d FROM practice_set WHERE deleted_at IS NULL')) days.add(r.d);
	return days;
}

export function streak(clock: StudyClock = studyClock()) {
	const days = activeDays();
	const studiedToday = days.has(clock.today);
	let d = studiedToday ? clock.today : addDays(clock.today, -1);
	let current = 0;
	while (days.has(d)) {
		current++;
		d = addDays(d, -1);
	}
	return { current, studiedToday };
}

export function studySecondsByDay(from: string, to: string): Map<string, number> {
	return new Map(
		all<{ d: string; s: number }>(
			'SELECT study_day AS d, sum(seconds) AS s FROM study_session WHERE study_day BETWEEN ? AND ? GROUP BY study_day',
			from,
			to
		).map((r) => [r.d, r.s])
	);
}

export function studyTimeSeries(clock: StudyClock, days: number) {
	const from = addDays(clock.today, -(days - 1));
	const map = studySecondsByDay(from, clock.today);
	return Array.from({ length: days }, (_, i) => {
		const day = addDays(from, i);
		return { day, seconds: map.get(day) ?? 0 };
	});
}

export function weekSummary(clock: StudyClock = studyClock()) {
	// Weeks start on Monday.
	const offset = (weekdayOf(clock.today) + 6) % 7;
	const weekStart = addDays(clock.today, -offset);
	let seconds = 0;
	for (const s of studySecondsByDay(weekStart, clock.today).values()) seconds += s;
	const settings = studySettings();
	return {
		weekStart,
		seconds,
		goalSeconds: settings.weeklyHours ? settings.weeklyHours * 3600 : null,
		todaySeconds: studySecondsByDay(clock.today, clock.today).get(clock.today) ?? 0,
		dailyGoalMinutes: dailyGoalMinutes(settings)
	};
}

// ------------------------------------------------------------ cards

export function retention(clock: StudyClock = studyClock(), days = 30) {
	const from = addDays(clock.today, -(days - 1));
	const r = one<{ total: number; passed: number | null }>(
		'SELECT count(*) AS total, sum(rating >= 2) AS passed FROM review_event WHERE prev_state = 2 AND study_day >= ?',
		from
	);
	return { total: r.total, passed: r.passed ?? 0, rate: r.total ? (r.passed ?? 0) / r.total : null };
}

/** Typical seconds per card, from recent reviews (capped at 60s like Anki). */
export function secondsPerCard() {
	const r = one<{ review: number | null; fresh: number | null }>(
		`SELECT avg(CASE WHEN prev_state != 0 THEN min(time_taken_ms, 60000) END) / 1000.0 AS review,
		        avg(CASE WHEN prev_state = 0 THEN min(time_taken_ms, 60000) END) / 1000.0 AS fresh
		 FROM (SELECT prev_state, time_taken_ms FROM review_event WHERE time_taken_ms > 0 ORDER BY reviewed_at DESC LIMIT 400)`
	);
	return {
		review: r.review && r.review > 1 ? r.review : 10,
		fresh: r.fresh && r.fresh > 1 ? r.fresh : 20
	};
}

export function dueSummary(clock: StudyClock = studyClock()): { counts: QueueCounts; minutes: number } {
	const counts = queueCounts(clock);
	const spc = secondsPerCard();
	const seconds = (counts.learning + counts.review) * spc.review + counts.new * spc.fresh;
	return { counts, minutes: seconds > 0 ? Math.max(1, Math.round(seconds / 60)) : 0 };
}

export interface ForecastDay {
	day: string;
	due: number;
	projected: number;
}

/**
 * Reviews per day for the coming days: cards already scheduled, plus an estimate
 * of what continuing at the current new-cards-per-day setting adds.
 */
export function forecast(clock: StudyClock = studyClock(), days = 7) {
	const s = studySettings();
	const end = addDays(clock.today, days - 1);
	const counts = new Map<string, number>();
	for (const r of all<{ due: number }>(
		`SELECT c.due FROM card c JOIN note n ON n.id = c.note_id
		 WHERE c.deleted_at IS NULL AND n.deleted_at IS NULL AND c.suspended = 0 AND c.state IN (1, 2, 3)`
	)) {
		let day = studyDayOf(r.due, s.timeZone, s.dayStartHour);
		if (day < clock.today) day = clock.today;
		if (day > end) continue;
		counts.set(day, (counts.get(day) ?? 0) + 1);
	}
	const qc = queueCounts(clock);
	const newPool = one<{ n: number }>(
		`SELECT count(*) AS n FROM card c JOIN note n ON n.id = c.note_id
		 WHERE c.deleted_at IS NULL AND n.deleted_at IS NULL AND c.suspended = 0 AND c.state = 0`
	).n;

	// Each new card typically comes back about 2, 7 and 21 days after it is learned.
	const simulate = (perDay: number) => {
		const extra = new Map<string, number>();
		let pool = newPool;
		for (let i = 0; i < days; i++) {
			const day = addDays(clock.today, i);
			const introduce = Math.min(pool, i === 0 ? Math.min(perDay, qc.new) : perDay);
			pool -= introduce;
			if (!introduce) continue;
			extra.set(day, (extra.get(day) ?? 0) + introduce);
			for (const o of [2, 7, 21]) {
				const d = addDays(day, o);
				if (d <= end) extra.set(d, (extra.get(d) ?? 0) + introduce);
			}
		}
		return Array.from({ length: days }, (_, i) => {
			const day = addDays(clock.today, i);
			const due = counts.get(day) ?? 0;
			return { day, due, projected: due + (extra.get(day) ?? 0) };
		});
	};

	const series = simulate(s.newCardsPerDay);
	const peak = series.reduce((m, d) => (d.projected > m.projected ? d : m), series[0]);
	const recentAvg = one<{ avg: number | null }>(
		`SELECT avg(n) AS avg FROM (SELECT count(*) AS n FROM review_event WHERE study_day >= ? GROUP BY study_day)`,
		addDays(clock.today, -14)
	).avg;
	const capacity = Math.max(150, Math.round((recentAvg ?? 0) * 1.5));
	let message: string;
	let warning = false;
	if (!newPool && series.every((d) => d.projected === 0)) {
		message = 'Nothing scheduled yet. Cards you make will show up here.';
	} else if (peak.projected > capacity) {
		warning = true;
		message = `At ${s.newCardsPerDay} new cards a day, ${dayName(peak.day, clock.today)} would reach about ${peak.projected} reviews. Consider fewer new cards for a few days.`;
	} else {
		const doubled = simulate(Math.max(s.newCardsPerDay * 2, s.newCardsPerDay + 10));
		const doubledPeak = doubled.reduce((m, d) => (d.projected > m.projected ? d : m), doubled[0]);
		message =
			newPool > 0
				? `At ${s.newCardsPerDay} new cards a day, reviews stay under ${roundUp(peak.projected)} a day. Doubling it would push ${dayName(doubledPeak.day, clock.today)} to about ${doubledPeak.projected}.`
				: `Reviews stay under ${roundUp(peak.projected)} a day this week.`;
	}
	return { days: series, message, warning, newPerDay: s.newCardsPerDay };
}

function roundUp(n: number) {
	if (n <= 10) return Math.max(1, n);
	return Math.ceil(n / 5) * 5;
}

function dayName(day: string, today: string) {
	const d = diffDays(today, day);
	if (d === 0) return 'today';
	if (d === 1) return 'tomorrow';
	return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][weekdayOf(day)];
}

// ----------------------------------------------------- full-lengths

export function fullLengthSummary() {
	const list = listFullLengths();
	const latest = list.at(-1) ?? null;
	const previous = list.length > 1 ? list[list.length - 2] : null;
	return {
		list,
		latest,
		previous,
		delta: latest?.total != null && previous?.total != null ? latest.total - previous.total : null
	};
}

// ---------------------------------------------------------- heatmap

export interface Evidence {
	value: number | null;
	n: number;
	last: string | null;
	enough: boolean;
}

export interface HeatCell {
	code: string;
	name: string;
	recall: Evidence;
	practice: Evidence;
	fullLength: { missed: number; exams: number; last: string | null; enough: boolean };
	openMistakes: number;
}

export interface HeatRow {
	section: SectionCode;
	name: string;
	cells: HeatCell[];
}

export function heatmap(clock: StudyClock = studyClock(), windowDays = EVIDENCE_WINDOW_DAYS): HeatRow[] {
	const from = addDays(clock.today, -(windowDays - 1));
	const recall = new Map(
		all<{ code: string; n: number; passed: number; last: string }>(
			`SELECT n.aamc_code AS code, count(*) AS n, sum(e.rating >= 2) AS passed, max(e.study_day) AS last
			 FROM review_event e JOIN card c ON c.id = e.card_id JOIN note n ON n.id = c.note_id
			 WHERE e.prev_state = 2 AND e.study_day >= ? AND n.aamc_code IS NOT NULL GROUP BY n.aamc_code`,
			from
		).map((r) => [r.code, r])
	);
	const practice = new Map<string, { n: number; correct: number; last: string }>();
	const addPractice = (code: string | null, n: number, correct: number, last: string) => {
		if (!code) return;
		const cur = practice.get(code) ?? { n: 0, correct: 0, last: '' };
		practice.set(code, { n: cur.n + n, correct: cur.correct + correct, last: cur.last > last ? cur.last : last });
	};
	for (const r of all<{ code: string; n: number; correct: number; last: string }>(
		`SELECT coalesce(aamc_code, skill_code) AS code, sum(total) AS n, sum(correct) AS correct, max(date) AS last
		 FROM practice_set WHERE deleted_at IS NULL AND date >= ? AND coalesce(aamc_code, skill_code) IS NOT NULL
		 GROUP BY coalesce(aamc_code, skill_code)`,
		from
	)) {
		addPractice(r.code, r.n, r.correct, r.last);
	}
	for (const r of all<{ code: string; n: number; correct: number; last: string }>(
		`SELECT coalesce(aamc_code, skill_code) AS code, count(*) AS n, sum(correct) AS correct, max(study_day) AS last
		 FROM attempt WHERE study_day >= ? AND coalesce(aamc_code, skill_code) IS NOT NULL
		 GROUP BY coalesce(aamc_code, skill_code)`,
		from
	)) {
		addPractice(r.code, r.n, r.correct, r.last);
	}
	const exams = listFullLengths();
	const recentExams = exams.slice(-5);
	const examIds = recentExams.map((e) => e.id);
	const flMissed = new Map<string, { n: number; last: string }>();
	if (examIds.length) {
		const ids = examIds.map(() => '?').join(',');
		const addMissed = (code: string, n: number, last: string) => {
			const cur = flMissed.get(code);
			flMissed.set(code, { n: (cur?.n ?? 0) + n, last: cur && cur.last > last ? cur.last : last });
		};
		// Mistakes logged from an exam, plus wrong questions imported from its review (each question counted once).
		for (const r of all<{ code: string; n: number; last: string }>(
			`SELECT coalesce(m.aamc_code, m.skill_code) AS code, count(*) AS n, max(f.date) AS last
			 FROM mistake m JOIN full_length f ON f.id = m.full_length_id
			 WHERE m.deleted_at IS NULL AND m.full_length_id IN (${ids})
			 AND m.id NOT IN (SELECT mistake_id FROM full_length_item WHERE mistake_id IS NOT NULL)
			 AND coalesce(m.aamc_code, m.skill_code) IS NOT NULL GROUP BY coalesce(m.aamc_code, m.skill_code)`,
			...examIds
		)) {
			addMissed(r.code, r.n, r.last);
		}
		for (const r of all<{ code: string; n: number; last: string }>(
			`SELECT coalesce(i.aamc_code, i.skill_code) AS code, count(*) AS n, max(f.date) AS last
			 FROM full_length_item i JOIN full_length f ON f.id = i.full_length_id
			 WHERE i.full_length_id IN (${ids}) AND (i.correct = 0 OR i.correct IS NULL)
			 AND coalesce(i.aamc_code, i.skill_code) IS NOT NULL GROUP BY coalesce(i.aamc_code, i.skill_code)`,
			...examIds
		)) {
			addMissed(r.code, r.n, r.last);
		}
	}
	const open = new Map(
		all<{ code: string; n: number }>(
			`SELECT coalesce(aamc_code, skill_code) AS code, count(*) AS n FROM mistake
			 WHERE deleted_at IS NULL AND state != 'resolved' AND coalesce(aamc_code, skill_code) IS NOT NULL
			 GROUP BY coalesce(aamc_code, skill_code)`
		).map((r) => [r.code, r.n])
	);

	const cell = (code: string): HeatCell => {
		const rc = recall.get(code);
		const pr = practice.get(code);
		const fl = flMissed.get(code);
		return {
			code,
			name: CATEGORY_SHORT[code] ?? code,
			recall: {
				value: rc && rc.n >= RECALL_MIN ? rc.passed / rc.n : null,
				n: rc?.n ?? 0,
				last: rc?.last ?? null,
				enough: !!rc && rc.n >= RECALL_MIN
			},
			practice: {
				value: pr && pr.n >= PRACTICE_MIN ? pr.correct / pr.n : null,
				n: pr?.n ?? 0,
				last: pr?.last || null,
				enough: !!pr && pr.n >= PRACTICE_MIN
			},
			fullLength: {
				missed: fl?.n ?? 0,
				exams: recentExams.length,
				last: fl?.last ?? (recentExams.at(-1)?.date ?? null),
				enough: recentExams.length > 0
			},
			openMistakes: open.get(code) ?? 0
		};
	};

	const order: SectionCode[] = ['CP', 'CARS', 'BB', 'PS'];
	return order.map((section) => ({
		section,
		name: SECTIONS.find((s) => s.code === section)!.short,
		cells:
			section === 'CARS'
				? CARS_SKILL_CODES.map(cell)
				: CATEGORIES.filter((c) => c.section === section).map((c) => cell(c.code))
	}));
}

export interface FocusArea {
	code: string;
	name: string;
	value: number | null;
	kind: 'recall' | 'practice' | 'mistakes';
	detail: string;
}

/** The weakest categories with enough evidence, or those with the most open mistakes. */
export function focusAreas(rows: HeatRow[] = heatmap()): FocusArea[] {
	const cells = rows.flatMap((r) => r.cells);
	const measured: FocusArea[] = [];
	for (const c of cells) {
		const options: FocusArea[] = [];
		if (c.recall.enough && c.recall.value !== null) {
			options.push({ code: c.code, name: c.name, value: c.recall.value, kind: 'recall', detail: `Recall · ${c.recall.n} reviews` });
		}
		if (c.practice.enough && c.practice.value !== null) {
			options.push({ code: c.code, name: c.name, value: c.practice.value, kind: 'practice', detail: `Practice · ${c.practice.n} questions` });
		}
		if (options.length) measured.push(options.sort((a, b) => a.value! - b.value!)[0]);
	}
	const weak = measured.filter((m) => m.value! < 0.85).sort((a, b) => a.value! - b.value!);
	const result = weak.slice(0, 3);
	if (result.length < 3) {
		const byMistakes = cells
			.filter((c) => c.openMistakes > 0 && !result.some((r) => r.code === c.code))
			.sort((a, b) => b.openMistakes - a.openMistakes)
			.slice(0, 3 - result.length)
			.map(
				(c): FocusArea => ({
					code: c.code,
					name: c.name,
					value: null,
					kind: 'mistakes',
					detail: `${c.openMistakes} open mistake${c.openMistakes === 1 ? '' : 's'}`
				})
			);
		result.push(...byMistakes);
	}
	return result;
}

export function mistakeReasons(fromDay?: string) {
	const rows = all<{ reason: string; n: number }>(
		`SELECT reason, count(*) AS n FROM mistake WHERE deleted_at IS NULL ${fromDay ? 'AND study_day >= ?' : ''} GROUP BY reason`,
		...(fromDay ? [fromDay] : [])
	);
	const total = rows.reduce((a, r) => a + r.n, 0);
	return {
		total,
		reasons: MISTAKE_REASONS.map((r) => {
			const n = rows.find((x) => x.reason === r.code)?.n ?? 0;
			return { code: r.code, label: r.label, n, pct: total ? Math.round((n / total) * 100) : 0 };
		}).sort((a, b) => b.n - a.n)
	};
}

export function cardTotals() {
	return one<{ total: number; reviewed: number; reviews30: number }>(
		`SELECT (SELECT count(*) FROM card c JOIN note n ON n.id = c.note_id WHERE c.deleted_at IS NULL AND n.deleted_at IS NULL) AS total,
		        (SELECT count(*) FROM card WHERE deleted_at IS NULL AND state != 0) AS reviewed,
		        (SELECT count(*) FROM review_event WHERE reviewed_at >= ?) AS reviews30`,
		Date.now() - 30 * 86_400_000
	);
}
