import { eq } from 'drizzle-orm';
import { cleanAppearance, DEFAULT_APPEARANCE, type AccountAppearance } from '../appearance';
import { db } from './db';
import { user } from './db/schema';

// The account's appearance settings (theme, page style, text size, decorations),
// stored on the user row so every device and the standby copy get them.

export function accountAppearance(): AccountAppearance {
	try {
		const row = db().select({ a: user.appearance }).from(user).where(eq(user.id, 1)).get();
		return cleanAppearance(row?.a ?? null);
	} catch {
		// Before setup (no account yet) or while the database is being swapped.
		return { ...DEFAULT_APPEARANCE };
	}
}

/** Merges a change into the saved settings; anything invalid keeps its current value. */
export function saveAccountAppearance(patch: Record<string, unknown>): AccountAppearance {
	const current = accountAppearance();
	const merged = cleanAppearance({ ...current, ...patch, holidays: { ...current.holidays, ...((patch.holidays as object) ?? {}) } }, current);
	db().update(user).set({ appearance: merged as unknown as Record<string, unknown>, updatedAt: Date.now() }).where(eq(user.id, 1)).run();
	return merged;
}
