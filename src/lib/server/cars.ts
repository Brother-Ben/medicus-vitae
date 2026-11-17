import { createHash } from 'node:crypto';
import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { addDays } from '../dates';
import { db, inTx, sqlite } from './db';
import { carsAttempt, carsPassage, carsQuestion, user } from './db/schema';
import { uuidv7 } from './ids';
import { studyClock, type StudyClock } from './settings';

// CARS practice: passages brought in from Jack Westin's free daily passages
// (with the "Send to Medicus" bookmark, see cars-import.ts), from AAMC material,
// or pasted in; timed attempts with every answer and the time on each question.

export class CarsError extends Error {}

export const JW_DAILY_URL = 'https://jackwestin.com/daily/mcat-practice-passages/cars-practice-passages/';

export interface CarsPrefs {
	/** Show "Today's passage" (and count toward a daily goal). */
	daily: boolean;
	/** How many passages a day. */
	perDay: number;
	/** When the bookmark was last used (so the setup hint can go away). */
	bookmarkUsedAt: number | null;
	/** Questions one at a time (like the MCAT) or all at once. */
	layout: 'one' | 'all';
}

export const DEFAULT_CARS: CarsPrefs = { daily: true, perDay: 1, bookmarkUsedAt: null, layout: 'one' };

export function cleanCarsPrefs(v: unknown): CarsPrefs {
	const o = (v && typeof v === 'object' ? v : {}) as Partial<CarsPrefs>;
	return {
		daily: typeof o.daily === 'boolean' ? o.daily : DEFAULT_CARS.daily,
		perDay: Math.max(1, Math.min(10, Math.round(Number(o.perDay) || DEFAULT_CARS.perDay))),
		bookmarkUsedAt: typeof o.bookmarkUsedAt === 'number' ? o.bookmarkUsedAt : null,
		layout: o.layout === 'all' ? 'all' : 'one'
	};
}

export function carsPrefs(): CarsPrefs {
	const u = db().select({ p: user.carsPrefs }).from(user).where(eq(user.id, 1)).get();
	return cleanCarsPrefs(u?.p ?? null);
}

export function updateCarsPrefs(patch: Partial<CarsPrefs>): CarsPrefs {
	const next = cleanCarsPrefs({ ...carsPrefs(), ...patch });
	db().update(user).set({ carsPrefs: next as unknown as Record<string, unknown>, updatedAt: Date.now() }).where(eq(user.id, 1)).run();
	return next;
}

// ------------------------------------------------------------ passages

export interface QuestionInput {
	stem: string;
	choices: string[];
	/** Index of the correct choice, when the page shows it. */
	answer: number | null;
	explanation?: string;
	skill?: string | null;
}

export interface PassageInput {
	source: 'jackwestin' | 'aamc' | 'other';
	sourceUrl?: string;
	title: string;
	publishedOn?: string | null;
	topic?: string;
	paragraphs: string[];
	questions: QuestionInput[];
	method: 'imported' | 'extracted' | 'pasted';
}

const clean = (s: string, max: number) => String(s ?? '').replace(/\r\n?/g, '\n').replace(/[ \t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

/** The page address without tracking bits (identity of a web passage). */
export function canonicalUrl(url: string): string {
	try {
		const u = new URL(url);
		u.hash = '';
		u.search = '';
		return u.toString().replace(/\/+$/, '');
	} catch {
		return '';
	}
}

function keyFor(input: PassageInput, body: string): string {
	const url = input.sourceUrl ? canonicalUrl(input.sourceUrl) : '';
	// A listing page shows whichever passage is current: key those by the passage itself.
	const listing = /cars-practice-passages\/?$/.test(url) || !url;
	if (!listing) return `url:${url}`;
	return `text:${createHash('sha256').update(body.replace(/\s+/g, ' ').trim().slice(0, 4000)).digest('hex').slice(0, 32)}`;
}

function cleanQuestions(qs: QuestionInput[]): QuestionInput[] {
	return qs
		.slice(0, 15)
		.map((q) => {
			const choices = (q.choices ?? []).map((c) => clean(c, 2000)).filter(Boolean).slice(0, 6);
			const answer = q.answer !== null && q.answer !== undefined && Number.isInteger(q.answer) && q.answer >= 0 && q.answer < choices.length ? q.answer : null;
			return { stem: clean(q.stem, 4000), choices, answer, explanation: clean(q.explanation ?? '', 8000), skill: q.skill && /^(FC|RWT|RBT)$/.test(q.skill) ? q.skill : null };
		})
		.filter((q) => q.stem && q.choices.length >= 2);
}

/** A question's identity across imports: its stem, case and spacing aside. */
const stemKey = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 80);

/**
 * Saves a passage. The same passage again (same page, or same text) keeps its
 * attempts and fills in what the new copy adds: answers and explanations that
 * show only after answering on the site, and questions it hadn't seen (sites
 * that show one question at a time). A passage you had deleted starts fresh.
 */
export function savePassage(input: PassageInput, clock: StudyClock = studyClock()): { id: string; created: boolean; answers: number; explanations: number } {
	const paragraphs = input.paragraphs.map((p) => clean(p, 20_000)).filter((p) => p.length > 0);
	const body = paragraphs.join('\n\n');
	if (body.split(/\s+/).length < 80) throw new CarsError('That doesn’t look like a CARS passage (the text is too short).');
	const questions = cleanQuestions(input.questions);
	const title = clean(input.title, 200) || paragraphs[0].split(/[.!?]/)[0].slice(0, 80);
	const sourceKey = keyFor(input, body);
	const now = Date.now();
	const existing = db().select().from(carsPassage).where(eq(carsPassage.sourceKey, sourceKey)).get();
	let id = existing?.id ?? uuidv7();
	const created = !existing;
	inTx(() => {
		if (existing) {
			const old = db().select().from(carsQuestion).where(eq(carsQuestion.passageId, id)).orderBy(asc(carsQuestion.position)).all();
			const wasDeleted = existing.deletedAt !== null && questions.length > 0;
			const used = wasDeleted ? (sqlite().prepare('SELECT count(*) AS n FROM cars_attempt WHERE passage_id = ? AND deleted_at IS NULL').get(id) as { n: number }).n : 0;
			if (used) {
				// Deleted, then brought in again, and past attempts point at the old
				// questions: the old copy stays deleted (under another key) and this one starts fresh.
				db().update(carsPassage).set({ sourceKey: `${sourceKey}:old:${now}`, deletedAt: existing.deletedAt }).where(eq(carsPassage.id, id)).run();
				id = uuidv7();
				insertPassage(id, input, title, body, sourceKey, clock, now);
				insertQuestions(id, questions, now);
				return;
			}
			db()
				.update(carsPassage)
				.set({ title, topic: clean(input.topic ?? '', 80) || existing.topic, publishedOn: input.publishedOn ?? existing.publishedOn, body, wordCount: body.split(/\s+/).length, deletedAt: null, updatedAt: now })
				.where(eq(carsPassage.id, id))
				.run();
			if (wasDeleted) {
				// Deleted, then brought in again: this copy's questions replace the old ones.
				db().delete(carsQuestion).where(eq(carsQuestion.passageId, id)).run();
				insertQuestions(id, questions, now);
			} else {
				// Questions already here get what this copy adds (answers, explanations);
				// new ones go after them. Nothing is removed, so attempts stay valid.
				const byStem = new Map(old.map((o) => [stemKey(o.stem), o]));
				const position = old.length ? Math.max(...old.map((o) => o.position)) + 1 : 0;
				const added: QuestionInput[] = [];
				let keyChanged = false;
				for (const q of questions) {
					const o = byStem.get(stemKey(q.stem));
					if (!o) {
						added.push(q);
						continue;
					}
					const answer = q.answer ?? o.answer;
					if (answer !== o.answer) keyChanged = true;
					db()
						.update(carsQuestion)
						.set({ choices: q.choices.length >= o.choices.length ? q.choices : o.choices, answer, explanation: q.explanation || o.explanation, skill: q.skill ?? o.skill })
						.where(eq(carsQuestion.id, o.id))
						.run();
				}
				if (added.length) insertQuestions(id, added, now, position);
				// A fuller copy (every question already here, and more) puts them in the site's order.
				const fuller = added.length > 0 && old.length > 0 && old.every((o) => questions.some((q) => stemKey(q.stem) === stemKey(o.stem)));
				if (fuller) {
					const rows = new Map(db().select().from(carsQuestion).where(eq(carsQuestion.passageId, id)).all().map((r) => [stemKey(r.stem), r.id]));
					questions.forEach((q, i) => {
						const rowId = rows.get(stemKey(q.stem));
						if (rowId) db().update(carsQuestion).set({ position: i }).where(eq(carsQuestion.id, rowId)).run();
					});
				}
				// Past tries are scored against the key as it is now.
				if (keyChanged) rescore(id);
			}
		} else {
			insertPassage(id, input, title, body, sourceKey, clock, now);
			insertQuestions(id, questions, now);
		}
	});
	const qs = db().select().from(carsQuestion).where(eq(carsQuestion.passageId, id)).all();
	return { id, created, answers: qs.filter((q) => q.answer !== null).length, explanations: qs.filter((q) => q.explanation).length };
}

function insertPassage(id: string, input: PassageInput, title: string, body: string, sourceKey: string, clock: StudyClock, now: number) {
	db()
		.insert(carsPassage)
		.values({
			id,
			source: input.source,
			sourceUrl: input.sourceUrl ? canonicalUrl(input.sourceUrl) || input.sourceUrl.slice(0, 500) : '',
			sourceKey,
			title,
			publishedOn: input.publishedOn && /^\d{4}-\d{2}-\d{2}$/.test(input.publishedOn) ? input.publishedOn : null,
			topic: clean(input.topic ?? '', 80),
			body,
			wordCount: body.split(/\s+/).length,
			method: input.method,
			importedDay: clock.today,
			createdAt: now,
			updatedAt: now
		})
		.run();
}

function insertQuestions(passageId: string, questions: QuestionInput[], now: number, from = 0) {
	questions.forEach((q, i) => {
		db()
			.insert(carsQuestion)
			.values({ id: uuidv7(), passageId, position: from + i, stem: q.stem, choices: q.choices, answer: q.answer, explanation: q.explanation ?? '', skill: q.skill ?? null, createdAt: now })
			.run();
	});
}

export interface PassageListItem {
	id: string;
	title: string;
	source: string;
	sourceUrl: string;
	topic: string;
	publishedOn: string | null;
	importedDay: string;
	wordCount: number;
	questions: number;
	answerKey: boolean;
	attempts: number;
	last: { correct: number; scored: number; total: number; seconds: number; day: string } | null;
	createdAt: number;
}

export function listPassages(): PassageListItem[] {
	const rows = sqlite()
		.prepare(
			`SELECT p.*, (SELECT count(*) FROM cars_question q WHERE q.passage_id = p.id) AS qn,
			        (SELECT count(*) FROM cars_question q WHERE q.passage_id = p.id AND q.answer IS NOT NULL) AS qa
			 FROM cars_passage p WHERE p.deleted_at IS NULL ORDER BY p.created_at DESC`
		)
		.all() as (Record<string, unknown> & { id: string; qn: number; qa: number })[];
	const attempts = new Map<string, { n: number; last: PassageListItem['last'] }>();
	for (const a of sqlite()
		.prepare('SELECT passage_id, correct, scored, total, seconds, study_day FROM cars_attempt WHERE deleted_at IS NULL ORDER BY finished_at')
		.all() as { passage_id: string; correct: number; scored: number; total: number; seconds: number; study_day: string }[]) {
		const e = attempts.get(a.passage_id) ?? { n: 0, last: null };
		e.n++;
		e.last = { correct: a.correct, scored: a.scored, total: a.total, seconds: a.seconds, day: a.study_day };
		attempts.set(a.passage_id, e);
	}
	return rows.map((r) => ({
		id: r.id,
		title: String(r.title),
		source: String(r.source),
		sourceUrl: String(r.source_url ?? ''),
		topic: String(r.topic ?? ''),
		publishedOn: (r.published_on as string | null) ?? null,
		importedDay: String(r.imported_day),
		wordCount: Number(r.word_count),
		questions: r.qn,
		answerKey: r.qn > 0 && r.qa === r.qn,
		attempts: attempts.get(r.id)?.n ?? 0,
		last: attempts.get(r.id)?.last ?? null,
		createdAt: Number(r.created_at)
	}));
}

export function getPassage(id: string) {
	const p = db().select().from(carsPassage).where(and(eq(carsPassage.id, id), isNull(carsPassage.deletedAt))).get();
	if (!p) return null;
	const questions = db().select().from(carsQuestion).where(eq(carsQuestion.passageId, id)).orderBy(asc(carsQuestion.position)).all();
	const attempts = db()
		.select()
		.from(carsAttempt)
		.where(and(eq(carsAttempt.passageId, id), isNull(carsAttempt.deletedAt)))
		.orderBy(desc(carsAttempt.finishedAt))
		.all();
	return { passage: p, questions, attempts };
}

export function deletePassage(id: string) {
	const now = Date.now();
	db().update(carsPassage).set({ deletedAt: now, updatedAt: now }).where(eq(carsPassage.id, id)).run();
}

export function restorePassage(id: string) {
	db().update(carsPassage).set({ deletedAt: null, updatedAt: Date.now() }).where(eq(carsPassage.id, id)).run();
}

/** Fixes the answer key by hand (when the page didn't show it). */
export function setAnswer(questionId: string, answer: number | null) {
	const q = db().select().from(carsQuestion).where(eq(carsQuestion.id, questionId)).get();
	if (!q) throw new CarsError('Question not found.');
	if (answer !== null && !(Number.isInteger(answer) && answer >= 0 && answer < q.choices.length)) throw new CarsError('Pick one of the choices.');
	db().update(carsQuestion).set({ answer }).where(eq(carsQuestion.id, questionId)).run();
	rescore(q.passageId);
}

/** Attempts are scored against the key as it is now (it may have been filled in later). */
function rescore(passageId: string) {
	const key = new Map(db().select().from(carsQuestion).where(eq(carsQuestion.passageId, passageId)).all().map((q) => [q.id, q.answer]));
	for (const a of db().select().from(carsAttempt).where(eq(carsAttempt.passageId, passageId)).all()) {
		const answers = a.answers.map((x) => {
			const k = key.get(x.questionId);
			const correct = k === null || k === undefined ? null : x.choice === null ? false : x.choice === k;
			return { ...x, correct };
		});
		db()
			.update(carsAttempt)
			.set({ answers, correct: answers.filter((x) => x.correct === true).length, scored: answers.filter((x) => x.correct !== null).length })
			.where(eq(carsAttempt.id, a.id))
			.run();
	}
}

export interface AttemptInput {
	startedAt: number;
	seconds: number;
	readingSeconds?: number;
	answers: { questionId: string; choice: number | null; seconds: number }[];
}

export function recordAttempt(passageId: string, input: AttemptInput, clock: StudyClock = studyClock()) {
	const p = getPassage(passageId);
	if (!p) throw new CarsError('Passage not found.');
	const answers = p.questions.map((q) => {
		const given = (input.answers ?? []).find((a) => a.questionId === q.id);
		const choice = given && given.choice !== null && Number.isInteger(given.choice) && given.choice >= 0 && given.choice < q.choices.length ? given.choice : null;
		const correct = q.answer === null ? null : choice === null ? false : choice === q.answer;
		return { questionId: q.id, choice, correct, seconds: Math.max(0, Math.min(3600, Math.round(Number(given?.seconds) || 0))) };
	});
	const now = Date.now();
	const id = uuidv7();
	const row = {
		id,
		passageId,
		startedAt: Math.min(now, Math.floor(Number(input.startedAt) || now)),
		finishedAt: now,
		seconds: Math.max(0, Math.min(4 * 3600, Math.round(Number(input.seconds) || 0))),
		readingSeconds: Math.max(0, Math.min(4 * 3600, Math.round(Number(input.readingSeconds) || 0))),
		correct: answers.filter((a) => a.correct === true).length,
		scored: answers.filter((a) => a.correct !== null).length,
		total: answers.length,
		answers,
		studyDay: clock.today,
		createdAt: now
	};
	db().insert(carsAttempt).values(row).run();
	// Time on a passage counts as practice time.
	sqlite()
		.prepare('INSERT INTO study_session (id, activity, started_at, ended_at, seconds, study_day, document_id, device_id) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)')
		.run(uuidv7(), 'practice', row.startedAt, now, row.seconds, clock.today, 'cars');
	return row;
}

export function deleteAttempt(id: string) {
	db().update(carsAttempt).set({ deletedAt: Date.now() }).where(eq(carsAttempt.id, id)).run();
}

// --------------------------------------------------------------- numbers

export interface CarsStats {
	passages: number;
	attempts: number;
	correct: number;
	scored: number;
	avgSeconds: number;
	avgQuestionSeconds: number;
	week: { passages: number; correct: number; total: number; avgSeconds: number };
	/** Accuracy by week, oldest first (last 8 weeks with attempts). */
	trend: { week: string; correct: number; scored: number; passages: number }[];
	bySkill: { skill: string; correct: number; scored: number }[];
}

export function carsStats(clock: StudyClock = studyClock()): CarsStats {
	const attempts = db().select().from(carsAttempt).where(isNull(carsAttempt.deletedAt)).orderBy(asc(carsAttempt.finishedAt)).all();
	const weekFrom = addDays(clock.today, -6);
	const recent = attempts.filter((a) => a.studyDay >= weekFrom);
	const sum = (xs: typeof attempts, f: (a: (typeof attempts)[number]) => number) => xs.reduce((n, a) => n + f(a), 0);
	const answered = attempts.flatMap((a) => a.answers);
	const trend = new Map<string, { week: string; correct: number; scored: number; passages: number }>();
	for (const a of attempts) {
		const d = new Date(`${a.studyDay}T12:00:00Z`);
		const monday = addDays(a.studyDay, -((d.getUTCDay() + 6) % 7));
		const e = trend.get(monday) ?? trend.set(monday, { week: monday, correct: 0, scored: 0, passages: 0 }).get(monday)!;
		e.correct += a.correct;
		e.scored += a.scored;
		e.passages++;
	}
	const skills = new Map<string, { skill: string; correct: number; scored: number }>();
	const qSkill = new Map(
		(sqlite().prepare('SELECT id, skill FROM cars_question WHERE skill IS NOT NULL').all() as { id: string; skill: string }[]).map((r) => [r.id, r.skill])
	);
	for (const x of answered) {
		const s = qSkill.get(x.questionId);
		if (!s || x.correct === null) continue;
		const e = skills.get(s) ?? skills.set(s, { skill: s, correct: 0, scored: 0 }).get(s)!;
		e.scored++;
		if (x.correct) e.correct++;
	}
	return {
		passages: (sqlite().prepare('SELECT count(*) AS n FROM cars_passage WHERE deleted_at IS NULL').get() as { n: number }).n,
		attempts: attempts.length,
		correct: sum(attempts, (a) => a.correct),
		scored: sum(attempts, (a) => a.scored),
		avgSeconds: attempts.length ? Math.round(sum(attempts, (a) => a.seconds) / attempts.length) : 0,
		avgQuestionSeconds: answered.length ? Math.round(answered.reduce((n, x) => n + x.seconds, 0) / answered.length) : 0,
		week: {
			passages: recent.length,
			correct: sum(recent, (a) => a.correct),
			total: sum(recent, (a) => a.scored),
			avgSeconds: recent.length ? Math.round(sum(recent, (a) => a.seconds) / recent.length) : 0
		},
		trend: [...trend.values()].slice(-8),
		bySkill: [...skills.values()].sort((a, b) => a.skill.localeCompare(b.skill))
	};
}

/** For Today and the CARS tab: today's goal and the next passage to do. */
export function carsToday(clock: StudyClock = studyClock()) {
	const prefs = carsPrefs();
	const importedToday = (sqlite().prepare("SELECT count(*) AS n FROM cars_passage WHERE deleted_at IS NULL AND imported_day = ? AND source = 'jackwestin'").get(clock.today) as { n: number }).n;
	const next = sqlite()
		.prepare(
			`SELECT p.id, p.title, p.source, p.published_on,
			        (SELECT count(*) FROM cars_question q WHERE q.passage_id = p.id) AS questions
			 FROM cars_passage p WHERE p.deleted_at IS NULL
			 AND NOT EXISTS (SELECT 1 FROM cars_attempt a WHERE a.passage_id = p.id AND a.deleted_at IS NULL)
			 ORDER BY p.created_at DESC LIMIT 1`
		)
		.get() as { id: string; title: string; source: string; published_on: string | null; questions: number } | undefined;
	const waiting = (
		sqlite()
			.prepare(
				`SELECT count(*) AS n FROM cars_passage p WHERE p.deleted_at IS NULL AND NOT EXISTS (SELECT 1 FROM cars_attempt a WHERE a.passage_id = p.id AND a.deleted_at IS NULL)`
			)
			.get() as { n: number }
	).n;
	const stats = carsStats(clock);
	const SOURCE: Record<string, string> = { jackwestin: 'Jack Westin', aamc: 'AAMC', other: 'Pasted' };
	return {
		daily: prefs.daily,
		perDay: prefs.perDay,
		importedToday,
		waiting,
		bookmarkSet: !!prefs.bookmarkUsedAt,
		dailyUrl: JW_DAILY_URL,
		next: next ? { id: next.id, title: next.title, source: SOURCE[next.source] ?? next.source, date: next.published_on, questions: next.questions } : null,
		week: { passages: stats.week.passages, correct: stats.week.correct, total: stats.week.total, avgSeconds: stats.week.avgSeconds }
	};
}
