// Date helpers shared by server and browser. A "study day" is a calendar date
// (YYYY-MM-DD) in the owner's time zone that starts at the day-start hour, so a
// review at 1 a.m. with a 4 a.m. day start counts toward the previous day (PLAT-06).

const fmtCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(timeZone: string) {
	let f = fmtCache.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat('en-US', {
			timeZone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
			hourCycle: 'h23'
		});
		fmtCache.set(timeZone, f);
	}
	return f;
}

export function isValidTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

function zonedParts(ms: number, timeZone: string) {
	const out: Record<string, number> = {};
	for (const p of partsFormatter(timeZone).formatToParts(new Date(ms))) {
		if (p.type !== 'literal') out[p.type] = Number(p.value);
	}
	return {
		year: out.year,
		month: out.month,
		day: out.day,
		hour: out.hour === 24 ? 0 : out.hour,
		minute: out.minute,
		second: out.second
	};
}

/** Offset of the zone from UTC at the given instant, in ms (positive east of UTC). */
function zoneOffset(ms: number, timeZone: string): number {
	const p = zonedParts(ms, timeZone);
	const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
	return asUtc - Math.floor(ms / 1000) * 1000;
}

/** The instant at which wall-clock time in `timeZone` reads the given date and hour. */
export function zonedToUtc(ymd: string, hour: number, timeZone: string): number {
	const [y, m, d] = ymd.split('-').map(Number);
	const guess = Date.UTC(y, m - 1, d, hour);
	const off1 = zoneOffset(guess, timeZone);
	let result = guess - off1;
	const off2 = zoneOffset(result, timeZone);
	if (off2 !== off1) result = guess - off2;
	return result;
}

export function pad2(n: number) {
	return String(n).padStart(2, '0');
}

export function ymdFromUtcDate(d: Date): string {
	return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

export function addDays(ymd: string, days: number): string {
	const [y, m, d] = ymd.split('-').map(Number);
	return ymdFromUtcDate(new Date(Date.UTC(y, m - 1, d + days)));
}

/** Whole days from a to b (b - a). */
export function diffDays(a: string, b: string): number {
	const [ay, am, ad] = a.split('-').map(Number);
	const [by, bm, bd] = b.split('-').map(Number);
	return Math.round((Date.UTC(by, bm - 1, bd) - Date.UTC(ay, am - 1, ad)) / 86_400_000);
}

/** 0 = Sunday … 6 = Saturday. */
export function weekdayOf(ymd: string): number {
	const [y, m, d] = ymd.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The study day an instant belongs to. */
export function studyDayOf(ms: number, timeZone: string, dayStartHour: number): string {
	const p = zonedParts(ms, timeZone);
	const ymd = `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
	return p.hour < dayStartHour ? addDays(ymd, -1) : ymd;
}

/** The instant the current study day ends (the next day-start hour). */
export function studyDayEnd(ms: number, timeZone: string, dayStartHour: number): number {
	const today = studyDayOf(ms, timeZone, dayStartHour);
	return zonedToUtc(addDays(today, 1), dayStartHour, timeZone);
}

/** The instant a given study day starts. */
export function studyDayStart(ymd: string, timeZone: string, dayStartHour: number): number {
	return zonedToUtc(ymd, dayStartHour, timeZone);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS_LONG = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December'
];

/** "Oct 24" */
export function shortDate(ymd: string): string {
	const [, m, d] = ymd.split('-').map(Number);
	return `${MONTHS[m - 1]} ${d}`;
}

/** "Sat, Jan 2, 2027" */
export function mediumDate(ymd: string): string {
	const [y, m, d] = ymd.split('-').map(Number);
	return `${WEEKDAYS[weekdayOf(ymd)]}, ${MONTHS[m - 1]} ${d}, ${y}`;
}

/** "Monday, October 26" */
export function longDate(ymd: string): string {
	const [, m, d] = ymd.split('-').map(Number);
	return `${WEEKDAYS_LONG[weekdayOf(ymd)]}, ${MONTHS_LONG[m - 1]} ${d}`;
}

export function weekdayShort(ymd: string): string {
	return WEEKDAYS[weekdayOf(ymd)];
}

/** Interval label for a rating button: "<1m", "10m", "1h", "3d", "2.4mo", "1.1y". */
export function intervalLabel(ms: number): string {
	const min = ms / 60_000;
	if (min < 1) return '<1m';
	if (min < 60) return `${Math.round(min)}m`;
	const hours = min / 60;
	if (hours < 24) return `${Math.round(hours)}h`;
	const days = hours / 24;
	if (days < 30) return `${Math.round(days)}d`;
	const months = days / 30.44;
	if (months < 12) return `${months.toFixed(1).replace(/\.0$/, '')}mo`;
	return `${(days / 365.25).toFixed(1).replace(/\.0$/, '')}y`;
}

/** "1h 20m", "35 min", "45s" */
export function durationLabel(seconds: number, style: 'short' | 'long' = 'short'): string {
	const s = Math.max(0, Math.round(seconds));
	if (s === 0) return style === 'long' ? '0 min' : '0m';
	if (s < 60) return `${s}s`;
	const totalMin = Math.round(s / 60);
	if (totalMin < 60) return style === 'long' ? `${totalMin} min` : `${totalMin}m`;
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return m ? `${h}h ${m}m` : `${h}h`;
}

/** "just now", "5 min ago", "3 hours ago", "Yesterday", "4 days ago", "Oct 3" */
export function relativeTime(ms: number, now = Date.now()): string {
	const diff = now - ms;
	if (diff < 0) {
		const ahead = -diff;
		if (ahead < 60_000) return 'in under a minute';
		if (ahead < 3_600_000) return `in ${Math.round(ahead / 60_000)} min`;
		if (ahead < 86_400_000) return `in ${Math.round(ahead / 3_600_000)} h`;
		return `in ${Math.round(ahead / 86_400_000)} days`;
	}
	if (diff < 45_000) return 'just now';
	if (diff < 3_600_000) return `${Math.max(1, Math.round(diff / 60_000))} min ago`;
	if (diff < 86_400_000) {
		const h = Math.round(diff / 3_600_000);
		return `${h} hour${h === 1 ? '' : 's'} ago`;
	}
	const days = Math.round(diff / 86_400_000);
	if (days === 1) return 'Yesterday';
	if (days < 14) return `${days} days ago`;
	const d = new Date(ms);
	return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}
