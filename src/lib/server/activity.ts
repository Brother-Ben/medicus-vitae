import { and, desc, eq, gte } from 'drizzle-orm';
import { db } from './db';
import { studySession } from './db/schema';
import { uuidv7 } from './ids';
import { studyDayFor } from './settings';

// Study time comes from heartbeats: pages report how many seconds the owner was
// actively studying (tab visible, recent input). Heartbeats close together
// extend one session; a gap starts a new one.

export const ACTIVITIES = ['review', 'reading', 'mistakes', 'practice'] as const;
export type Activity = (typeof ACTIVITIES)[number];

const MERGE_GAP_MS = 3 * 60_000;
const MAX_BEAT_SECONDS = 120;

export function recordActivity(input: { activity: string; seconds: number; documentId?: string | null; deviceId?: string }) {
	if (!(ACTIVITIES as readonly string[]).includes(input.activity)) return;
	const seconds = Math.max(0, Math.min(MAX_BEAT_SECONDS, Math.round(Number(input.seconds) || 0)));
	if (!seconds) return;
	const now = Date.now();
	const day = studyDayFor(now);
	const deviceId = String(input.deviceId ?? '').slice(0, 64);
	const recent = db()
		.select()
		.from(studySession)
		.where(
			and(
				eq(studySession.activity, input.activity),
				eq(studySession.deviceId, deviceId),
				eq(studySession.studyDay, day),
				gte(studySession.endedAt, now - MERGE_GAP_MS)
			)
		)
		.orderBy(desc(studySession.endedAt))
		.limit(1)
		.get();
	if (recent && (recent.documentId ?? null) === (input.documentId ?? null)) {
		db()
			.update(studySession)
			.set({ endedAt: now, seconds: recent.seconds + seconds })
			.where(eq(studySession.id, recent.id))
			.run();
		return;
	}
	db()
		.insert(studySession)
		.values({
			id: uuidv7(),
			activity: input.activity,
			startedAt: now - seconds * 1000,
			endedAt: now,
			seconds,
			studyDay: day,
			documentId: input.documentId ?? null,
			deviceId
		})
		.run();
}
