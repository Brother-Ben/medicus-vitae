// When each seasonal or holiday decoration shows. All local dates, worked out
// offline: seasons by month, US Thanksgiving by its rule, Christmas by date,
// and Ramadan with the browser's built-in Islamic (Umm al-Qura) calendar,
// because it moves about 11 days earlier every year.

import type { AccountAppearance, HolidayId, Season, ThemeId } from '../appearance';

export type { Season };
export type Decoration = Season | HolidayId;

export const DECORATIONS: { id: Decoration; name: string; kind: 'season' | 'holiday' }[] = [
	{ id: 'spring', name: 'Spring', kind: 'season' },
	{ id: 'summer', name: 'Summer', kind: 'season' },
	{ id: 'fall', name: 'Fall', kind: 'season' },
	{ id: 'winter', name: 'Winter', kind: 'season' },
	{ id: 'christmas', name: 'Christmas', kind: 'holiday' },
	{ id: 'thanksgiving', name: 'Thanksgiving', kind: 'holiday' },
	{ id: 'ramadan', name: 'Ramadan', kind: 'holiday' }
];

const THEME_SEASON: Partial<Record<ThemeId, Season>> = {
	spring: 'spring',
	'spring-night': 'spring',
	summer: 'summer',
	'summer-night': 'summer',
	fall: 'fall',
	'fall-night': 'fall',
	winter: 'winter',
	'winter-night': 'winter'
};

const DAY = 86_400_000;

/** Midnight at the start of a local date. */
function startOfDay(d: Date) {
	return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number) {
	const out = new Date(d);
	out.setDate(out.getDate() + n);
	return out;
}

/** Fall: September–November. Winter: December–February. Spring: March–May. Summer: June–August. */
export function seasonOf(date: Date): Season {
	const m = date.getMonth();
	if (m >= 8 && m <= 10) return 'fall';
	if (m === 11 || m <= 1) return 'winter';
	if (m <= 4) return 'spring';
	return 'summer';
}

/** US Thanksgiving: the fourth Thursday of November. */
export function thanksgivingDay(year: number): Date {
	const firstWeekday = new Date(year, 10, 1).getDay();
	const firstThursday = 1 + ((4 - firstWeekday + 7) % 7);
	return new Date(year, 10, firstThursday + 21);
}

/** The week of Thanksgiving: the Monday before it through the Sunday after. */
export function isThanksgivingWeek(date: Date): boolean {
	const t = thanksgivingDay(date.getFullYear());
	const d = startOfDay(date);
	return d >= addDays(t, -3) && d <= addDays(t, 3);
}

/** About December 1–26. */
export function isChristmasSeason(date: Date): boolean {
	return date.getMonth() === 11 && date.getDate() <= 26;
}

let islamicFormat: Intl.DateTimeFormat | null | undefined;

/** The Islamic (Umm al-Qura) month of a date, 1–12, or null if the browser can't tell. */
export function islamicMonth(date: Date): number | null {
	if (islamicFormat === undefined) {
		try {
			islamicFormat = new Intl.DateTimeFormat('en-US-u-ca-islamic-umalqura', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'UTC' });
		} catch {
			islamicFormat = null;
		}
	}
	if (!islamicFormat) return null;
	// The local calendar date, read at noon UTC so time zones can't move it to another day.
	const utcNoon = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate(), 12));
	const month = islamicFormat.formatToParts(utcNoon).find((p) => p.type === 'month')?.value;
	const n = Number(month);
	return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

/**
 * Whether a date falls in Ramadan (Islamic month 9). `offset` moves Ramadan by a
 * day for local moon sighting: +1 when it starts (and ends) a day later locally.
 */
export function isRamadan(date: Date, offset: -1 | 0 | 1 = 0): boolean {
	return islamicMonth(addDays(startOfDay(date), -offset)) === 9;
}

/** Ramadan periods that touch a calendar year (there can be two, as in 2030), first and last day. */
export function ramadanPeriods(year: number, offset: -1 | 0 | 1 = 0): { start: Date; end: Date }[] {
	const out: { start: Date; end: Date }[] = [];
	let current: { start: Date; end: Date } | null = null;
	for (let d = new Date(year, 0, 1); d.getFullYear() === year; d = addDays(d, 1)) {
		if (isRamadan(d, offset)) {
			if (!current) current = { start: d, end: d };
			current.end = d;
		} else if (current) {
			out.push(current);
			current = null;
		}
	}
	if (current) {
		// Runs into next year: follow it to its end.
		let d = addDays(current.end, 1);
		while (isRamadan(d, offset)) {
			current.end = d;
			d = addDays(d, 1);
		}
		out.push(current);
	}
	if (out.length && isRamadan(out[0].start, offset) && isRamadan(addDays(out[0].start, -1), offset)) {
		// Started last year: find the real first day.
		let d = out[0].start;
		while (isRamadan(addDays(d, -1), offset)) d = addDays(d, -1);
		out[0].start = d;
	}
	return out;
}

/**
 * Which decoration shows on a date. A holiday replaces the season's during its
 * dates (Ramadan first if two overlap, then Christmas, then Thanksgiving).
 * The season is the one picked in Settings (whatever the date), the active
 * season theme's ("match"), or the calendar's.
 */
export function decorationFor(
	date: Date,
	a: Pick<AccountAppearance, 'decorations' | 'holidays' | 'ramadanOffset'> & { decorSeason?: AccountAppearance['decorSeason'] },
	theme?: ThemeId
): Decoration | null {
	if (a.decorations === 'off') return null;
	if (a.decorations === 'all') {
		if (a.holidays.ramadan && isRamadan(date, a.ramadanOffset)) return 'ramadan';
		if (a.holidays.christmas && isChristmasSeason(date)) return 'christmas';
		if (a.holidays.thanksgiving && isThanksgivingWeek(date)) return 'thanksgiving';
	}
	const pick = a.decorSeason ?? 'match';
	if (pick === 'spring' || pick === 'summer' || pick === 'fall' || pick === 'winter') return pick;
	if (pick === 'match' && theme && THEME_SEASON[theme]) return THEME_SEASON[theme]!;
	return seasonOf(date);
}

export { DAY };
