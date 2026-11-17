// When decorations show: season boundaries, US Thanksgiving, Christmas, and
// Ramadan (Umm al-Qura calendar) against published dates, with the ±1 day setting.

import { describe, expect, it } from 'vitest';
import { DEFAULT_APPEARANCE } from '../appearance';
import { decorationFor, isChristmasSeason, isRamadan, isThanksgivingWeek, ramadanPeriods, seasonOf, thanksgivingDay } from './calendar';

const day = (s: string) => {
	const [y, m, d] = s.split('-').map(Number);
	return new Date(y, m - 1, d, 12);
};
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

describe('seasons', () => {
	it('changes on the first of September, December, March and June', () => {
		expect(seasonOf(day('2026-08-31'))).toBe('summer');
		expect(seasonOf(day('2026-09-01'))).toBe('fall');
		expect(seasonOf(day('2026-11-30'))).toBe('fall');
		expect(seasonOf(day('2026-12-01'))).toBe('winter');
		expect(seasonOf(day('2027-02-28'))).toBe('winter');
		expect(seasonOf(day('2028-02-29'))).toBe('winter');
		expect(seasonOf(day('2027-03-01'))).toBe('spring');
		expect(seasonOf(day('2027-05-31'))).toBe('spring');
		expect(seasonOf(day('2027-06-01'))).toBe('summer');
	});
});

describe('Thanksgiving', () => {
	it('is the fourth Thursday of November', () => {
		const published: Record<number, string> = {
			2024: '2024-11-28',
			2025: '2025-11-27',
			2026: '2026-11-26',
			2027: '2027-11-25',
			2028: '2028-11-23',
			2029: '2029-11-22',
			2030: '2030-11-28'
		};
		for (const [year, date] of Object.entries(published)) {
			const t = thanksgivingDay(Number(year));
			expect(iso(t)).toBe(date);
			expect(t.getDay()).toBe(4);
		}
	});

	it('decorates the Monday before through the Sunday after', () => {
		expect(isThanksgivingWeek(day('2026-11-22'))).toBe(false); // Sunday before
		expect(isThanksgivingWeek(day('2026-11-23'))).toBe(true); // Monday
		expect(isThanksgivingWeek(day('2026-11-26'))).toBe(true); // the day
		expect(isThanksgivingWeek(day('2026-11-29'))).toBe(true); // Sunday after
		expect(isThanksgivingWeek(day('2026-11-30'))).toBe(false);
	});
});

describe('Christmas', () => {
	it('runs December 1 to 26', () => {
		expect(isChristmasSeason(day('2026-11-30'))).toBe(false);
		expect(isChristmasSeason(day('2026-12-01'))).toBe(true);
		expect(isChristmasSeason(day('2026-12-26'))).toBe(true);
		expect(isChristmasSeason(day('2026-12-27'))).toBe(false);
	});
});

describe('Ramadan', () => {
	// First and last day of Ramadan as published (Umm al-Qura; Eid al-Fitr is the day after the last).
	const published: [number, string, string][] = [
		[2021, '2021-04-13', '2021-05-12'],
		[2022, '2022-04-02', '2022-05-01'],
		[2023, '2023-03-23', '2023-04-20'],
		[2024, '2024-03-11', '2024-04-09'],
		[2025, '2025-03-01', '2025-03-29'],
		[2026, '2026-02-18', '2026-03-19']
	];

	it('matches the published start and end dates', () => {
		for (const [year, start, end] of published) {
			const [p] = ramadanPeriods(year);
			expect([iso(p.start), iso(p.end)]).toEqual([start, end]);
			expect(isRamadan(day(start))).toBe(true);
			expect(isRamadan(day(end))).toBe(true);
			const before = day(start);
			before.setDate(before.getDate() - 1);
			const after = day(end);
			after.setDate(after.getDate() + 1);
			expect(isRamadan(before)).toBe(false);
			expect(isRamadan(after)).toBe(false); // Eid al-Fitr
		}
	});

	it('moves by a day either way for local moon sighting', () => {
		const [later] = ramadanPeriods(2026, 1);
		expect([iso(later.start), iso(later.end)]).toEqual(['2026-02-19', '2026-03-20']);
		const [earlier] = ramadanPeriods(2026, -1);
		expect([iso(earlier.start), iso(earlier.end)]).toEqual(['2026-02-17', '2026-03-18']);
		expect(isRamadan(day('2026-02-18'), 1)).toBe(false);
		expect(isRamadan(day('2026-03-20'), 1)).toBe(true);
	});

	it('finds both Ramadans in a year that has two (2030)', () => {
		const periods = ramadanPeriods(2030);
		expect(periods).toHaveLength(2);
		expect(iso(periods[0].start)).toBe('2030-01-05');
		expect(iso(periods[1].start)).toBe('2030-12-26');
		// The second one runs into 2031.
		expect(periods[1].end.getFullYear()).toBe(2031);
	});
});

describe('which decoration shows', () => {
	const settings = { ...DEFAULT_APPEARANCE };

	it('shows a holiday instead of the season during its dates', () => {
		expect(decorationFor(day('2026-10-28'), settings)).toBe('fall');
		expect(decorationFor(day('2026-11-26'), settings)).toBe('thanksgiving');
		expect(decorationFor(day('2026-12-10'), settings)).toBe('christmas');
		expect(decorationFor(day('2026-12-28'), settings)).toBe('winter');
		expect(decorationFor(day('2026-03-01'), settings)).toBe('ramadan');
		expect(decorationFor(day('2026-04-15'), settings)).toBe('spring');
		expect(decorationFor(day('2026-07-04'), settings)).toBe('summer');
	});

	it('shows a season picked in Settings whatever the date, or the season theme’s', () => {
		expect(decorationFor(day('2026-07-04'), { ...settings, decorSeason: 'winter' })).toBe('winter');
		expect(decorationFor(day('2026-07-04'), { ...settings, decorSeason: 'match' }, 'fall-night')).toBe('fall');
		expect(decorationFor(day('2026-07-04'), { ...settings, decorSeason: 'match' }, 'clinic-dark')).toBe('summer');
		expect(decorationFor(day('2026-07-04'), { ...settings, decorSeason: 'calendar' }, 'fall-night')).toBe('summer');
		// Holidays still come first when they're on.
		expect(decorationFor(day('2026-12-10'), { ...settings, decorSeason: 'spring' })).toBe('christmas');
		expect(decorationFor(day('2026-12-10'), { ...settings, decorations: 'seasons', decorSeason: 'spring' })).toBe('spring');
	});

	it('follows the settings', () => {
		expect(decorationFor(day('2026-12-10'), { ...settings, decorations: 'seasons' })).toBe('winter');
		expect(decorationFor(day('2026-12-10'), { ...settings, holidays: { ...settings.holidays, christmas: false } })).toBe('winter');
		expect(decorationFor(day('2026-10-28'), { ...settings, decorations: 'off' })).toBeNull();
		expect(decorationFor(day('2026-02-18'), { ...settings, ramadanOffset: 1 })).toBe('winter');
	});
});
