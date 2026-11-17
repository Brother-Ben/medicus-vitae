import { and, asc, eq } from 'drizzle-orm';
import { db } from './db';
import { job } from './db/schema';
import { uuidv7 } from './ids';
import { isPrimary } from './instance';

// A small durable queue in SQLite. Jobs run one at a time. A job that was
// running when the app stopped is queued again at startup and redone from the
// beginning, so interrupted work never leaves half-written records behind.

export type JobRow = typeof job.$inferSelect;

export interface JobContext {
	progress(fraction: number, message?: string): void;
	signal: AbortSignal;
}

type Handler = (row: JobRow, ctx: JobContext) => Promise<void>;

const handlers = new Map<string, Handler>();
let running = false;
let stopped = false;
let current: AbortController | null = null;
let idle: Promise<void> = Promise.resolve();

export function registerJobHandler(type: string, handler: Handler) {
	handlers.set(type, handler);
}

export function enqueueJob(type: string, payload: Record<string, unknown>): string {
	const id = uuidv7();
	const now = Date.now();
	db().insert(job).values({ id, type, payload, status: 'queued', createdAt: now, updatedAt: now }).run();
	kickJobs();
	return id;
}

/** At startup: anything marked running was interrupted. */
export function recoverJobs() {
	db()
		.update(job)
		.set({ status: 'queued', message: 'Restarting after an interruption', updatedAt: Date.now() })
		.where(eq(job.status, 'running'))
		.run();
}

export function kickJobs() {
	if (running || stopped || !isPrimary()) return;
	running = true;
	idle = loop().finally(() => {
		running = false;
	});
}

async function loop() {
	while (!stopped) {
		const next = db()
			.select()
			.from(job)
			.where(eq(job.status, 'queued'))
			.orderBy(asc(job.createdAt))
			.limit(1)
			.get();
		if (!next) return;
		const handler = handlers.get(next.type);
		const now = Date.now();
		if (!handler) {
			db()
				.update(job)
				.set({ status: 'failed', error: `No handler for ${next.type}`, updatedAt: now, finishedAt: now })
				.where(eq(job.id, next.id))
				.run();
			continue;
		}
		db()
			.update(job)
			.set({ status: 'running', attempts: next.attempts + 1, progress: 0, error: null, updatedAt: now })
			.where(eq(job.id, next.id))
			.run();
		current = new AbortController();
		let lastWrite = 0;
		const ctx: JobContext = {
			signal: current.signal,
			progress(fraction, message) {
				const t = Date.now();
				if (t - lastWrite < 500 && fraction < 1) return;
				lastWrite = t;
				db()
					.update(job)
					.set({ progress: Math.max(0, Math.min(1, fraction)), message: message ?? '', updatedAt: t })
					.where(and(eq(job.id, next.id), eq(job.status, 'running')))
					.run();
			}
		};
		try {
			await handler({ ...next, attempts: next.attempts + 1 }, ctx);
			if (stopped) return; // leave it 'running' so it is redone next start
			db()
				.update(job)
				.set({ status: 'done', progress: 1, updatedAt: Date.now(), finishedAt: Date.now() })
				.where(eq(job.id, next.id))
				.run();
		} catch (err) {
			if (stopped) return;
			const message = err instanceof Error ? err.message : String(err);
			db()
				.update(job)
				.set({ status: 'failed', error: message, updatedAt: Date.now(), finishedAt: Date.now() })
				.where(eq(job.id, next.id))
				.run();
		} finally {
			current = null;
		}
	}
}

export async function stopJobs() {
	stopped = true;
	current?.abort();
	await idle.catch(() => {});
}

export function resumeJobs() {
	stopped = false;
	kickJobs();
}

export function latestJobFor(type: string, key: string, value: string) {
	const rows = db().select().from(job).where(eq(job.type, type)).all();
	return rows.filter((r) => r.payload[key] === value).sort((a, b) => b.createdAt - a.createdAt)[0];
}
