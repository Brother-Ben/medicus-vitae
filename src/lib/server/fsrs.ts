import { createHash } from 'node:crypto';
import {
	createEmptyCard,
	fsrs,
	FSRSVersion,
	generatorParameters,
	StrategyMode,
	type Card as FsrsCard,
	type FSRSParameters,
	type Grade
} from 'ts-fsrs';
import { eq } from 'drizzle-orm';
import { db } from './db';
import { schedulerConfig, type card } from './db/schema';

// FSRS via ts-fsrs. Each review stores the scheduler version, its parameters
// (by reference) and the fuzz seed, so replaying a card's reviews in order
// reproduces its state exactly. Confidence ratings never reach this module.

export const SCHEDULER_NAME = `ts-fsrs ${FSRSVersion}`;

export type CardRow = typeof card.$inferSelect;

export interface SchedState {
	due: number;
	stability: number;
	difficulty: number;
	elapsedDays: number;
	scheduledDays: number;
	learningSteps: number;
	reps: number;
	lapses: number;
	state: number;
	lastReview: number | null;
}

export function currentParams(desiredRetention: number): FSRSParameters {
	const retention = Math.min(0.99, Math.max(0.7, desiredRetention || 0.9));
	return generatorParameters({
		request_retention: retention,
		maximum_interval: 36500,
		enable_fuzz: true,
		enable_short_term: true
	});
}

function canonical(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonical);
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.keys(value as Record<string, unknown>)
				.sort()
				.map((k) => [k, canonical((value as Record<string, unknown>)[k])])
		);
	}
	return value;
}

const configCache = new Map<string, FSRSParameters>();

/** Id of the stored scheduler config for these parameters (created on first use). */
export function ensureSchedulerConfig(params: FSRSParameters): string {
	const plain = canonical(JSON.parse(JSON.stringify(params))) as Record<string, unknown>;
	const id = 'sc-' + createHash('sha256').update(SCHEDULER_NAME + JSON.stringify(plain)).digest('hex').slice(0, 24);
	if (!configCache.has(id)) {
		db()
			.insert(schedulerConfig)
			.values({ id, scheduler: SCHEDULER_NAME, params: plain, createdAt: Date.now() })
			.onConflictDoNothing()
			.run();
		configCache.set(id, params);
	}
	return id;
}

export function loadSchedulerParams(id: string): FSRSParameters {
	const cached = configCache.get(id);
	if (cached) return cached;
	const row = db().select().from(schedulerConfig).where(eq(schedulerConfig.id, id)).get();
	if (!row) throw new Error(`Unknown scheduler config ${id}`);
	const params = generatorParameters(row.params as Partial<FSRSParameters>);
	configCache.set(id, params);
	return params;
}

export function clearSchedulerCache() {
	configCache.clear();
}

export function toFsrs(s: SchedState): FsrsCard {
	return {
		due: new Date(s.due),
		stability: s.stability,
		difficulty: s.difficulty,
		elapsed_days: s.elapsedDays,
		scheduled_days: s.scheduledDays,
		learning_steps: s.learningSteps,
		reps: s.reps,
		lapses: s.lapses,
		state: s.state,
		last_review: s.lastReview ? new Date(s.lastReview) : undefined
	};
}

export function fromFsrs(c: FsrsCard): SchedState {
	return {
		due: c.due.getTime(),
		stability: c.stability,
		difficulty: c.difficulty,
		elapsedDays: c.elapsed_days,
		scheduledDays: c.scheduled_days,
		learningSteps: c.learning_steps,
		reps: c.reps,
		lapses: c.lapses,
		state: c.state,
		lastReview: c.last_review ? c.last_review.getTime() : null
	};
}

export function schedState(row: CardRow): SchedState {
	return {
		due: row.due,
		stability: row.stability,
		difficulty: row.difficulty,
		elapsedDays: row.elapsedDays,
		scheduledDays: row.scheduledDays,
		learningSteps: row.learningSteps,
		reps: row.reps,
		lapses: row.lapses,
		state: row.state,
		lastReview: row.lastReview
	};
}

/** State of a card that has never been reviewed. */
export function emptyState(createdAt: number): SchedState {
	return fromFsrs(createEmptyCard(new Date(createdAt)));
}

function scheduler(params: FSRSParameters, seed: string) {
	return fsrs(params).useStrategy(StrategyMode.SEED, () => seed);
}

/** Next due time for each rating if the card were answered at `now`. */
export function previewDue(s: SchedState, params: FSRSParameters, now: number, seed: string): Record<Grade, number> {
	const log = scheduler(params, seed).repeat(toFsrs(s), new Date(now));
	return { 1: log[1].card.due.getTime(), 2: log[2].card.due.getTime(), 3: log[3].card.due.getTime(), 4: log[4].card.due.getTime() };
}

export function applyRating(s: SchedState, params: FSRSParameters, now: number, rating: Grade, seed: string): SchedState {
	return fromFsrs(scheduler(params, seed).next(toFsrs(s), new Date(now), rating).card);
}

export interface ReplayEvent {
	rating: number;
	reviewedAt: number;
	seed: string;
	schedulerConfigId: string;
}

/** A due date set by hand: only `due` moves. */
export interface DueChange {
	due: number;
	changedAt: number;
}

/** Moves the due date and nothing else (what the scheduler knows about the card is untouched). */
export function applyDueChange(s: SchedState, change: DueChange): SchedState {
	return { ...s, due: change.due };
}

/**
 * Recomputes a card's state from scratch: empty card at creation, then every
 * review in order, with due dates set by hand applied at the time they were
 * set (a change at the same moment as a review counts as after it).
 */
export function replay(createdAt: number, events: ReplayEvent[], dueChanges: DueChange[] = []): SchedState {
	let s = emptyState(createdAt);
	const changes = [...dueChanges].sort((a, b) => a.changedAt - b.changedAt);
	let c = 0;
	for (const e of events) {
		while (c < changes.length && changes[c].changedAt < e.reviewedAt) s = applyDueChange(s, changes[c++]);
		s = applyRating(s, loadSchedulerParams(e.schedulerConfigId), e.reviewedAt, e.rating as Grade, e.seed);
	}
	while (c < changes.length) s = applyDueChange(s, changes[c++]);
	return s;
}

export function sameState(a: SchedState, b: SchedState): boolean {
	return (
		a.due === b.due &&
		a.stability === b.stability &&
		a.difficulty === b.difficulty &&
		a.elapsedDays === b.elapsedDays &&
		a.scheduledDays === b.scheduledDays &&
		a.learningSteps === b.learningSteps &&
		a.reps === b.reps &&
		a.lapses === b.lapses &&
		a.state === b.state &&
		(a.lastReview ?? null) === (b.lastReview ?? null)
	);
}
