import { and, asc, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
	CARS_SKILL_CODES,
	MISTAKE_REASONS,
	isCategoryCode,
	isSkillCode,
	SECTION_SCORE,
	TOTAL_SCORE,
	type MistakeState
} from '../aamc';
import { kindForNoteType, notePreview } from '../cards';
import { addDays } from '../dates';
import { db, sqlite } from './db';
import {
	attempt,
	card,
	fullLength,
	mistake,
	mistakeEvent,
	mistakeLink,
	note,
	practiceSet,
	tombstone
} from './db/schema';
import { uuidv7 } from './ids';
import { anchorLabel, anchorViews } from './reading';
import { studyClock, studyDayFor } from './settings';

export class PracticeError extends Error {}

const SOURCE_TYPES = ['practice', 'full_length', 'card', 'external'] as const;
type SourceType = (typeof SOURCE_TYPES)[number];

function code(v: unknown) {
	return typeof v === 'string' && (isCategoryCode(v) || CARS_SKILL_CODES.includes(v)) ? v : null;
}

function skillCode(v: unknown) {
	return typeof v === 'string' && isSkillCode(v) ? v : null;
}

function text(v: unknown, max = 5000) {
	return String(v ?? '').trim().slice(0, max);
}

// ------------------------------------------------------------- mistakes

export interface MistakeInput {
	sourceType: SourceType;
	sourceRef?: string;
	fullLengthId?: string | null;
	practiceSetId?: string | null;
	cardId?: string | null;
	aamcCode?: string | null;
	skillCode?: string | null;
	reason: string;
	summary?: string;
	whatToDo?: string;
	links?: { kind: 'card' | 'anchor'; refId: string }[];
}

function validate(input: MistakeInput) {
	if (!SOURCE_TYPES.includes(input.sourceType)) throw new PracticeError('Pick where the mistake came from.');
	if (!MISTAKE_REASONS.some((r) => r.code === input.reason)) throw new PracticeError('Pick why you missed it.');
	return {
		sourceType: input.sourceType,
		sourceRef: text(input.sourceRef, 200),
		fullLengthId: input.sourceType === 'full_length' ? (input.fullLengthId ?? null) : null,
		practiceSetId: input.sourceType === 'practice' ? (input.practiceSetId ?? null) : null,
		cardId: input.cardId ?? null,
		aamcCode: code(input.aamcCode),
		skillCode: skillCode(input.skillCode),
		reason: input.reason,
		summary: text(input.summary),
		whatToDo: text(input.whatToDo)
	};
}

function addEvent(mistakeId: string, from: string | null, to: string, noteText = '') {
	db()
		.insert(mistakeEvent)
		.values({ id: uuidv7(), mistakeId, fromState: from, toState: to, note: noteText, createdAt: Date.now() })
		.run();
}

export function createMistake(input: MistakeInput) {
	const values = validate(input);
	const now = Date.now();
	const id = uuidv7();
	db().transaction((tx) => {
		tx.insert(mistake)
			.values({ id, ...values, state: 'open', studyDay: studyDayFor(now), createdAt: now, updatedAt: now })
			.run();
		const links = [...(input.links ?? [])];
		if (values.cardId && !links.some((l) => l.kind === 'card' && l.refId === values.cardId)) {
			links.push({ kind: 'card', refId: values.cardId });
		}
		for (const l of links.slice(0, 50)) {
			if (l.kind !== 'card' && l.kind !== 'anchor') continue;
			tx.insert(mistakeLink).values({ id: uuidv7(), mistakeId: id, kind: l.kind, refId: l.refId, createdAt: now }).run();
		}
		addEvent(id, null, 'open', 'Logged');
	});
	return id;
}

export function updateMistake(id: string, input: MistakeInput) {
	const current = getMistakeRow(id);
	const values = validate(input);
	db()
		.update(mistake)
		.set({ ...values, updatedAt: Date.now() })
		.where(eq(mistake.id, current.id))
		.run();
}

function getMistakeRow(id: string) {
	const row = db().select().from(mistake).where(eq(mistake.id, id)).get();
	if (!row || row.deletedAt) throw new PracticeError('Mistake not found.');
	return row;
}

function setState(id: string, from: MistakeState, to: MistakeState, patch: Partial<typeof mistake.$inferInsert>, noteText: string) {
	const write = () => {
		db()
			.update(mistake)
			.set({ ...patch, state: to, updatedAt: Date.now() })
			.where(eq(mistake.id, id))
			.run();
		addEvent(id, from, to, noteText);
	};
	if (sqlite().inTransaction) write();
	else db().transaction(write);
}

export function startRepair(id: string) {
	const m = getMistakeRow(id);
	if (m.state !== 'open') throw new PracticeError('Only an open mistake can start repair.');
	setState(id, 'open', 'repair', {}, 'Started repair');
}

/** Repair done: passage revisited and the concept explained. Schedules a retest on a later day. */
export function completeRepair(id: string, input: { explanation: string; passageRevisited: boolean; retestInDays?: number }) {
	const m = getMistakeRow(id);
	if (m.state !== 'repair') throw new PracticeError('Start the repair first.');
	const explanation = text(input.explanation, 20_000);
	if (explanation.length < 10) throw new PracticeError('Explain the idea in your own words (a sentence or two).');
	const days = Math.max(1, Math.min(30, Math.floor(input.retestInDays ?? 2)));
	setState(
		id,
		'repair',
		'retest',
		{ repairExplanation: explanation, passageRevisited: !!input.passageRevisited, retestDue: addDays(studyClock().today, days) },
		`Repaired; retest in ${days} day${days === 1 ? '' : 's'}`
	);
}

/** Records a retest on a different question about the same idea. Passing resolves; failing reopens. */
export function logRetest(id: string, input: { correct: boolean; externalRef?: string; note?: string; confidence?: string | null }) {
	const m = getMistakeRow(id);
	if (m.state !== 'retest') throw new PracticeError('This mistake is not waiting for a retest.');
	const now = Date.now();
	const previous = db()
		.select()
		.from(attempt)
		.where(and(eq(attempt.mistakeId, id), eq(attempt.source, 'retest')))
		.all().length;
	db().transaction(() => {
		db()
			.insert(attempt)
			.values({
				id: uuidv7(),
				questionId: null,
				externalRef: text(input.externalRef, 200),
				source: 'retest',
				attemptNumber: previous + 1,
				correct: !!input.correct,
				confidence: ['guess', 'unsure', 'sure'].includes(input.confidence ?? '') ? input.confidence : null,
				aamcCode: m.aamcCode,
				skillCode: m.skillCode,
				mistakeId: id,
				attemptedAt: now,
				studyDay: studyDayFor(now),
				createdAt: now
			})
			.run();
		if (input.correct) {
			setState(id, 'retest', 'resolved', { resolvedAt: now }, text(input.note) || 'Retest passed');
		} else {
			setState(
				id,
				'retest',
				'open',
				{ reopenedCount: m.reopenedCount + 1, retestDue: null },
				text(input.note) || 'Retest failed; reopened'
			);
		}
	});
}

export function reopenMistake(id: string) {
	const m = getMistakeRow(id);
	if (m.state !== 'resolved') throw new PracticeError('Only a resolved mistake can be reopened.');
	setState(id, 'resolved', 'open', { reopenedCount: m.reopenedCount + 1, resolvedAt: null, retestDue: null }, 'Reopened');
}

export function deleteMistake(id: string) {
	const now = Date.now();
	db().transaction((tx) => {
		tx.update(mistake).set({ deletedAt: now, updatedAt: now }).where(eq(mistake.id, id)).run();
		tx.insert(tombstone).values({ id: uuidv7(), recordType: 'mistake', recordId: id, deletedAt: now }).run();
	});
}

export function listMistakes(filter: { state?: string | null; aamcCode?: string | null; reason?: string | null } = {}) {
	const conds = [isNull(mistake.deletedAt)];
	if (filter.state === 'active') conds.push(inArray(mistake.state, ['open', 'repair', 'retest']));
	else if (filter.state) conds.push(eq(mistake.state, filter.state));
	if (filter.aamcCode) conds.push(eq(mistake.aamcCode, filter.aamcCode));
	if (filter.reason) conds.push(eq(mistake.reason, filter.reason));
	return db()
		.select()
		.from(mistake)
		.where(and(...conds))
		.orderBy(desc(mistake.createdAt))
		.all();
}

export function mistakeDetail(id: string) {
	const m = getMistakeRow(id);
	const links = db().select().from(mistakeLink).where(eq(mistakeLink.mistakeId, id)).all();
	const anchors = anchorViews(links.filter((l) => l.kind === 'anchor').map((l) => l.refId));
	const cardIds = links.filter((l) => l.kind === 'card').map((l) => l.refId);
	const cards = cardIds.length
		? db()
				.select({ c: card, n: note })
				.from(card)
				.innerJoin(note, eq(note.id, card.noteId))
				.where(inArray(card.id, cardIds))
				.all()
		: [];
	const cardAnchors = anchorViews(cards.map((x) => x.n.anchorId ?? '').filter(Boolean));
	return {
		mistake: m,
		events: db().select().from(mistakeEvent).where(eq(mistakeEvent.mistakeId, id)).orderBy(asc(mistakeEvent.createdAt)).all(),
		attempts: db().select().from(attempt).where(eq(attempt.mistakeId, id)).orderBy(asc(attempt.attemptedAt)).all(),
		passages: links
			.filter((l) => l.kind === 'anchor')
			.map((l) => {
				const a = anchors.get(l.refId) ?? null;
				return { linkId: l.id, anchor: a, label: anchorLabel(a) };
			}),
		cards: cards.map(({ c, n }) => {
			const a = n.anchorId ? (cardAnchors.get(n.anchorId) ?? null) : null;
			return {
				cardId: c.id,
				noteId: n.id,
				deleted: !!(c.deletedAt || n.deletedAt),
				preview: notePreview(kindForNoteType(n.noteTypeId), n.fields),
				sourceAnchorId: a?.id ?? null,
				sourceLabel: anchorLabel(a)
			};
		}),
		fullLength: m.fullLengthId ? db().select().from(fullLength).where(eq(fullLength.id, m.fullLengthId)).get() : null,
		practiceSet: m.practiceSetId ? db().select().from(practiceSet).where(eq(practiceSet.id, m.practiceSetId)).get() : null
	};
}

export function addMistakeLink(id: string, kind: 'card' | 'anchor', refId: string) {
	getMistakeRow(id);
	db().insert(mistakeLink).values({ id: uuidv7(), mistakeId: id, kind, refId, createdAt: Date.now() }).run();
}

export function removeMistakeLink(linkId: string) {
	db().delete(mistakeLink).where(eq(mistakeLink.id, linkId)).run();
}

// ---------------------------------------------------------- full-lengths

export interface FullLengthInput {
	date: string;
	provider: string;
	form?: string;
	total?: number | null;
	cp?: number | null;
	cars?: number | null;
	bb?: number | null;
	ps?: number | null;
	notes?: string;
}

function score(v: unknown, min: number, max: number, label: string): number | null {
	if (v === null || v === undefined || v === '') return null;
	const n = Math.round(Number(v));
	if (!Number.isFinite(n) || n < min || n > max) throw new PracticeError(`${label} must be between ${min} and ${max}.`);
	return n;
}

function validateFullLength(input: FullLengthInput) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')) throw new PracticeError('Pick the date you took it.');
	const provider = text(input.provider, 80);
	if (!provider) throw new PracticeError('Pick who made the exam.');
	const cp = score(input.cp, SECTION_SCORE.min, SECTION_SCORE.max, 'Chem/Phys');
	const cars = score(input.cars, SECTION_SCORE.min, SECTION_SCORE.max, 'CARS');
	const bb = score(input.bb, SECTION_SCORE.min, SECTION_SCORE.max, 'Bio/Biochem');
	const ps = score(input.ps, SECTION_SCORE.min, SECTION_SCORE.max, 'Psych/Soc');
	let total = score(input.total, TOTAL_SCORE.min, TOTAL_SCORE.max, 'Total');
	const sections = [cp, cars, bb, ps];
	if (sections.every((s) => s !== null)) {
		const sum = sections.reduce((a, b) => a! + b!, 0)!;
		if (total !== null && total !== sum) {
			throw new PracticeError(`The sections add up to ${sum}, but the total says ${total}.`);
		}
		total = sum;
	}
	if (total === null) throw new PracticeError('Enter the total score or all four section scores.');
	return { date: input.date, provider, form: text(input.form, 80), total, cp, cars, bb, ps, notes: text(input.notes, 20_000) };
}

export function createFullLength(input: FullLengthInput) {
	const values = validateFullLength(input);
	const now = Date.now();
	const id = uuidv7();
	db().insert(fullLength).values({ id, ...values, createdAt: now, updatedAt: now }).run();
	return id;
}

export function updateFullLength(id: string, input: FullLengthInput) {
	const values = validateFullLength(input);
	db().update(fullLength).set({ ...values, updatedAt: Date.now() }).where(eq(fullLength.id, id)).run();
}

export function deleteFullLength(id: string) {
	const now = Date.now();
	db().transaction((tx) => {
		tx.update(fullLength).set({ deletedAt: now, updatedAt: now }).where(eq(fullLength.id, id)).run();
		tx.insert(tombstone).values({ id: uuidv7(), recordType: 'full_length', recordId: id, deletedAt: now }).run();
	});
}

export function listFullLengths() {
	return db().select().from(fullLength).where(isNull(fullLength.deletedAt)).orderBy(asc(fullLength.date), asc(fullLength.createdAt)).all();
}

export function getFullLength(id: string) {
	const fl = db().select().from(fullLength).where(eq(fullLength.id, id)).get();
	if (!fl || fl.deletedAt) return null;
	const mistakes = db()
		.select()
		.from(mistake)
		.where(and(eq(mistake.fullLengthId, id), isNull(mistake.deletedAt)))
		.orderBy(asc(mistake.createdAt))
		.all();
	return { fullLength: fl, mistakes };
}

// --------------------------------------------------------- practice sets

export interface PracticeSetInput {
	date: string;
	source: string;
	section?: string | null;
	aamcCode?: string | null;
	skillCode?: string | null;
	total: number;
	correct: number;
	minutes?: number | null;
	notes?: string;
}

function validatePracticeSet(input: PracticeSetInput) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date ?? '')) throw new PracticeError('Pick the date.');
	const source = text(input.source, 80);
	if (!source) throw new PracticeError('Say where the questions came from.');
	const total = Math.round(Number(input.total));
	const correct = Math.round(Number(input.correct));
	if (!(total >= 1 && total <= 1000)) throw new PracticeError('Number of questions must be at least 1.');
	if (!(correct >= 0 && correct <= total)) throw new PracticeError('Correct answers must be between 0 and the number of questions.');
	const minutes = input.minutes === null || input.minutes === undefined || (input.minutes as unknown) === '' ? null : Math.round(Number(input.minutes));
	const section = ['CP', 'CARS', 'BB', 'PS'].includes(input.section ?? '') ? input.section! : null;
	return {
		date: input.date,
		source,
		section,
		aamcCode: code(input.aamcCode),
		skillCode: skillCode(input.skillCode),
		total,
		correct,
		minutes: minutes !== null && Number.isFinite(minutes) && minutes >= 0 ? minutes : null,
		notes: text(input.notes, 5000)
	};
}

export function createPracticeSet(input: PracticeSetInput) {
	const values = validatePracticeSet(input);
	const now = Date.now();
	const id = uuidv7();
	db().insert(practiceSet).values({ id, ...values, createdAt: now, updatedAt: now }).run();
	return id;
}

export function deletePracticeSet(id: string) {
	const now = Date.now();
	db().transaction((tx) => {
		tx.update(practiceSet).set({ deletedAt: now, updatedAt: now }).where(eq(practiceSet.id, id)).run();
		tx.insert(tombstone).values({ id: uuidv7(), recordType: 'practice_set', recordId: id, deletedAt: now }).run();
	});
}

export function listPracticeSets(limit = 100) {
	return db()
		.select()
		.from(practiceSet)
		.where(isNull(practiceSet.deletedAt))
		.orderBy(desc(practiceSet.date), desc(practiceSet.createdAt))
		.limit(limit)
		.all();
}
