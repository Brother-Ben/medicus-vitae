import { eq } from 'drizzle-orm';
import { isValidTimeZone, studyDayEnd, studyDayOf } from '../dates';
import { cleanFocus, type FocusPrefs } from '../focus';
import { db } from './db';
import { user, type Baseline } from './db/schema';

export interface StudySettings {
	displayName: string;
	timeZone: string;
	dayStartHour: number;
	newCardsPerDay: number;
	desiredRetention: number;
	leechThreshold: number;
	testDate: string | null;
	goalScore: number | null;
	weeklyHours: number | null;
	studyDays: number[];
	baseline: Baseline | null;
}

const DEFAULTS: StudySettings = {
	displayName: '',
	timeZone: 'UTC',
	dayStartHour: 4,
	newCardsPerDay: 20,
	desiredRetention: 0.9,
	leechThreshold: 8,
	testDate: null,
	goalScore: null,
	weeklyHours: null,
	studyDays: [1, 2, 3, 4, 5, 6],
	baseline: null
};

export function studySettings(): StudySettings {
	const u = db().select().from(user).where(eq(user.id, 1)).get();
	if (!u) return DEFAULTS;
	return {
		displayName: u.displayName,
		timeZone: isValidTimeZone(u.timeZone) ? u.timeZone : 'UTC',
		dayStartHour: u.dayStartHour,
		newCardsPerDay: u.newCardsPerDay,
		desiredRetention: u.desiredRetention,
		leechThreshold: u.leechThreshold,
		testDate: u.testDate,
		goalScore: u.goalScore,
		weeklyHours: u.weeklyHours,
		studyDays: u.studyDays,
		baseline: u.baseline
	};
}

export interface StudyClock {
	now: number;
	today: string;
	dayEnd: number;
	timeZone: string;
	dayStartHour: number;
}

export function studyClock(now = Date.now(), s: StudySettings = studySettings()): StudyClock {
	return {
		now,
		today: studyDayOf(now, s.timeZone, s.dayStartHour),
		dayEnd: studyDayEnd(now, s.timeZone, s.dayStartHour),
		timeZone: s.timeZone,
		dayStartHour: s.dayStartHour
	};
}

export function studyDayFor(ms: number): string {
	const s = studySettings();
	return studyDayOf(ms, s.timeZone, s.dayStartHour);
}

export class SettingsError extends Error {}

export function updateStudySettings(patch: Partial<StudySettings>) {
	const values: Partial<typeof user.$inferInsert> = { updatedAt: Date.now() };
	if (patch.displayName !== undefined) values.displayName = patch.displayName.trim().slice(0, 60);
	if (patch.timeZone !== undefined) {
		if (!isValidTimeZone(patch.timeZone)) throw new SettingsError('Unknown time zone.');
		values.timeZone = patch.timeZone;
	}
	if (patch.dayStartHour !== undefined) {
		const h = Math.floor(patch.dayStartHour);
		if (!(h >= 0 && h <= 12)) throw new SettingsError('Day start must be between midnight and noon.');
		values.dayStartHour = h;
	}
	if (patch.newCardsPerDay !== undefined) {
		const n = Math.floor(patch.newCardsPerDay);
		if (!(n >= 0 && n <= 9999)) throw new SettingsError('New cards per day must be 0 or more.');
		values.newCardsPerDay = n;
	}
	if (patch.desiredRetention !== undefined) {
		const r = patch.desiredRetention;
		if (!(r >= 0.7 && r <= 0.99)) throw new SettingsError('Desired retention must be between 70% and 99%.');
		values.desiredRetention = Math.round(r * 100) / 100;
	}
	if (patch.leechThreshold !== undefined) {
		const n = Math.floor(patch.leechThreshold);
		if (!(n >= 3 && n <= 99)) throw new SettingsError('Leech threshold must be between 3 and 99.');
		values.leechThreshold = n;
	}
	if (patch.testDate !== undefined) {
		if (patch.testDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(patch.testDate)) throw new SettingsError('Bad test date.');
		values.testDate = patch.testDate;
	}
	if (patch.goalScore !== undefined) {
		if (patch.goalScore !== null && !(patch.goalScore >= 472 && patch.goalScore <= 528)) {
			throw new SettingsError('Goal score must be between 472 and 528.');
		}
		values.goalScore = patch.goalScore;
	}
	if (patch.weeklyHours !== undefined) {
		if (patch.weeklyHours !== null && !(patch.weeklyHours > 0 && patch.weeklyHours <= 100)) {
			throw new SettingsError('Weekly hours must be between 1 and 100.');
		}
		values.weeklyHours = patch.weeklyHours;
	}
	if (patch.studyDays !== undefined) {
		const days = [...new Set(patch.studyDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
		if (!days.length) throw new SettingsError('Pick at least one study day.');
		values.studyDays = days;
	}
	if (patch.baseline !== undefined) values.baseline = patch.baseline;
	db().update(user).set(values).where(eq(user.id, 1)).run();
}

/** Focus timer, breaks and session presets (Settings › Focus & breaks). */
export function focusPrefs(): FocusPrefs {
	const u = db().select({ p: user.studyPrefs }).from(user).where(eq(user.id, 1)).get();
	return cleanFocus(u?.p ?? null);
}

export function updateFocusPrefs(patch: Partial<FocusPrefs>): FocusPrefs {
	const next = cleanFocus({ ...focusPrefs(), ...patch, promptKinds: { ...focusPrefs().promptKinds, ...(patch.promptKinds ?? {}) } });
	db()
		.update(user)
		.set({ studyPrefs: next as unknown as Record<string, unknown>, updatedAt: Date.now() })
		.where(eq(user.id, 1))
		.run();
	return next;
}

/** Daily study goal in minutes, from weekly hours spread over study days. */
export function dailyGoalMinutes(s: StudySettings = studySettings()): number | null {
	if (!s.weeklyHours) return null;
	return Math.round((s.weeklyHours * 60) / Math.max(1, s.studyDays.length));
}
