import { eq } from 'drizzle-orm';
import { db } from './db';
import { user } from './db/schema';

// The first-time guide: a tour of every tab. It shows once per account (on any
// device) until it's finished or skipped; Settings can start it again any time.

export function guideDone(): boolean {
	try {
		const row = db().select({ at: user.guideDoneAt }).from(user).where(eq(user.id, 1)).get();
		return !row || row.at !== null;
	} catch {
		return true;
	}
}

/** Marks the guide finished (it won't show by itself again), or not yet seen. */
export function setGuideDone(done: boolean) {
	db()
		.update(user)
		.set({ guideDoneAt: done ? Date.now() : null, updatedAt: Date.now() })
		.where(eq(user.id, 1))
		.run();
}
