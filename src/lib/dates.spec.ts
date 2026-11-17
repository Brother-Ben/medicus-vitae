import { describe, expect, it } from 'vitest';
import { addDays, diffDays, intervalLabel, studyDayEnd, studyDayOf, zonedToUtc } from './dates';

const TZ = 'America/Chicago';

describe('study days (PLAT-06)', () => {
	it('counts a review after midnight but before the day-start hour toward the previous day', () => {
		// 01:30 Chicago time on Oct 27 = 06:30 UTC (CDT, UTC-5).
		const at = Date.parse('2026-10-27T06:30:00Z');
		expect(studyDayOf(at, TZ, 4)).toBe('2026-10-26');
		// 04:30 local is after the 4 a.m. start, so it is the new day.
		expect(studyDayOf(Date.parse('2026-10-27T09:30:00Z'), TZ, 4)).toBe('2026-10-27');
		// With a midnight day start, 01:30 already belongs to the new day.
		expect(studyDayOf(at, TZ, 0)).toBe('2026-10-27');
	});

	it('handles the daylight-saving change', () => {
		// US clocks fall back on 2026-11-01 at 02:00 local. 04:30 local CST = 10:30 UTC.
		expect(studyDayOf(Date.parse('2026-11-01T10:30:00Z'), TZ, 4)).toBe('2026-11-01');
		// 03:30 local CST (09:30 UTC) is before the 4 a.m. start: previous day.
		expect(studyDayOf(Date.parse('2026-11-01T09:30:00Z'), TZ, 4)).toBe('2026-10-31');
		// Spring forward 2027-03-14: 04:30 CDT = 09:30 UTC is the new day.
		expect(studyDayOf(Date.parse('2027-03-14T09:30:00Z'), TZ, 4)).toBe('2027-03-14');
	});

	it('finds the end of the current study day', () => {
		const at = Date.parse('2026-10-27T15:00:00Z'); // 10:00 local
		expect(new Date(studyDayEnd(at, TZ, 4)).toISOString()).toBe('2026-10-28T09:00:00.000Z');
		expect(new Date(zonedToUtc('2026-10-28', 4, TZ)).toISOString()).toBe('2026-10-28T09:00:00.000Z');
	});

	it('does calendar arithmetic on YYYY-MM-DD strings', () => {
		expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
		expect(addDays('2027-03-01', -1)).toBe('2027-02-28');
		expect(diffDays('2026-10-26', '2027-01-02')).toBe(68);
	});

	it('labels intervals like Anki', () => {
		expect(intervalLabel(30_000)).toBe('<1m');
		expect(intervalLabel(10 * 60_000)).toBe('10m');
		expect(intervalLabel(3 * 86_400_000)).toBe('3d');
		expect(intervalLabel(75 * 86_400_000)).toBe('2.5mo');
	});
});
