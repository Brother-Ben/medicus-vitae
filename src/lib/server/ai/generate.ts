import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import { clozeNumbers } from '../../cards';
import { createNote } from '../cards';
import { db, sqlite } from '../db';
import { annotation, attempt, docSection, document, generatedItem, question, type Citation } from '../db/schema';
import { uuidv7 } from '../ids';
import { enqueueJob, registerJobHandler } from '../jobs';
import { createAnnotation } from '../reading';
import { studyDayFor } from '../settings';
import { cleanPassage, splitPage } from './chunking';
import { CHECK_SCHEMA, CHECK_SYSTEM, GENERATE_SCHEMAS, generateSystem, QUESTION_CHECK_SCHEMA, QUESTION_CHECK_SYSTEM, sourcesBlock } from './prompts';
import { complete } from './providers';
import { passageLabel } from './retrieval';
import { buildCitations, type SentPassage } from './tutor';

// AI-generated cards, quiz questions and notes from a chosen section (AI-02).
// Every item keeps its source anchors and waits for the owner's approval;
// items that fail a check are flagged and can't be approved in bulk. Nothing
// generated is ever used as evidence by the tutor.

export type GenKind = 'card' | 'question' | 'note';

export class GenerateError extends Error {}

const MAX_PASSAGES = 24;

/** Passages from a section's pages, spread evenly when there are many. */
export function sectionPassages(documentId: string, pageStart: number, pageEnd: number): SentPassage[] {
	const doc = db().select().from(document).where(eq(document.id, documentId)).get();
	if (!doc?.currentVersionId) throw new GenerateError('That book isn’t ready yet.');
	const pages = sqlite()
		.prepare('SELECT page_number, text FROM doc_page WHERE version_id = ? AND page_number BETWEEN ? AND ? ORDER BY page_number')
		.all(doc.currentVersionId, pageStart, pageEnd) as { page_number: number; text: string }[];
	const sections = db().select().from(docSection).where(eq(docSection.documentId, documentId)).all();
	const all: Omit<SentPassage, 'sid'>[] = [];
	for (const p of pages) {
		const section = sections.filter((s) => p.page_number >= s.pageStart && p.page_number <= s.pageEnd).sort((a, b) => b.level - a.level)[0]?.title ?? null;
		for (const span of splitPage(p.text)) {
			const text = cleanPassage(p.text.slice(span.start, span.end));
			if (text.length < 120) continue;
			all.push({
				chunkId: 0,
				kind: 'page',
				provenance: 'original',
				docId: documentId,
				versionId: doc.currentVersionId,
				page: p.page_number,
				textStart: span.start,
				textEnd: span.end,
				rects: null,
				refId: null,
				section,
				text,
				label: passageLabel({ kind: 'page', page: p.page_number, section, provenance: 'original' }, doc.title),
				score: 1
			});
		}
	}
	if (!all.length) throw new GenerateError('No text was found on those pages.');
	const step = Math.max(1, all.length / MAX_PASSAGES);
	const picked: Omit<SentPassage, 'sid'>[] = [];
	for (let i = 0; i < all.length && picked.length < MAX_PASSAGES; i += step) picked.push(all[Math.floor(i)]);
	return picked.map((p, i) => ({ ...p, sid: `S${i + 1}` }));
}

interface RawCard {
	type: 'basic' | 'cloze';
	front: string;
	back: string;
	text: string;
	sources: string[];
}
interface RawQuestion {
	stem: string;
	choices: string[];
	answer: number;
	explanation: string;
	sources: string[];
}
interface RawNote {
	title: string;
	body: string;
	sources: string[];
}

function itemProblem(kind: GenKind, item: RawCard | RawQuestion | RawNote, sent: Set<string>): string | null {
	if (!item.sources?.length) return 'cites no source';
	if (item.sources.some((s) => !sent.has(s))) return 'cites a passage that wasn’t provided';
	if (kind === 'card') {
		const c = item as RawCard;
		if (c.type === 'cloze' ? !clozeNumbers(c.text).length : !c.front.trim() || !c.back.trim()) return 'is incomplete';
	} else if (kind === 'question') {
		const q = item as RawQuestion;
		if (!q.stem.trim() || q.choices.length !== 4 || q.choices.some((c) => !String(c).trim())) return 'doesn’t have four choices';
		if (!Number.isInteger(q.answer) || q.answer < 0 || q.answer > 3) return 'has no valid answer';
	} else if (!(item as RawNote).body.trim()) return 'is empty';
	return null;
}

function statementFor(kind: GenKind, item: RawCard | RawQuestion | RawNote) {
	if (kind === 'card') {
		const c = item as RawCard;
		return c.type === 'cloze' ? c.text.replace(/\{\{c\d+::([\s\S]*?)(?:::[\s\S]*?)?\}\}/g, '$1') : `${c.front} — ${c.back}`;
	}
	if (kind === 'note') return `${(item as RawNote).title}: ${(item as RawNote).body}`;
	const q = item as RawQuestion;
	return `${q.stem}\nChoices: ${q.choices.map((c, i) => `(${'ABCD'[i]}) ${c}`).join(' ')}\nKeyed answer: ${'ABCD'[q.answer]}\nExplanation: ${q.explanation}`;
}

export async function generateItems(input: { documentId: string; sectionId?: string | null; pageStart?: number; pageEnd?: number; kind: GenKind; count: number; batchId?: string }) {
	const kind = input.kind;
	const count = Math.max(1, Math.min(20, Math.floor(input.count) || 8));
	let pageStart = input.pageStart ?? 1;
	let pageEnd = input.pageEnd ?? pageStart;
	let sectionId: string | null = input.sectionId ?? null;
	let aamcCode: string | null = null;
	if (sectionId) {
		const s = db().select().from(docSection).where(eq(docSection.id, sectionId)).get();
		if (!s) throw new GenerateError('That section no longer exists.');
		pageStart = s.pageStart;
		pageEnd = s.pageEnd;
		aamcCode = s.aamcCodes[0] ?? s.suggestedCodes[0]?.code ?? null;
	} else {
		sectionId = null;
	}
	const passages = sectionPassages(input.documentId, pageStart, pageEnd);
	const sent = new Set(passages.map((p) => p.sid));
	const res = await complete({
		feature: 'generate',
		system: generateSystem(kind),
		schema: GENERATE_SCHEMAS[kind] as unknown as Record<string, unknown>,
		effort: 'medium',
		maxTokens: 16000,
		messages: [{ role: 'user', content: `${sourcesBlock(passages)}\n\nWrite up to ${count} ${kind === 'card' ? 'flashcards' : kind === 'question' ? 'questions' : 'notes'} from these passages.` }]
	});
	const raw = ((res.json as { items?: unknown[] })?.items ?? []).slice(0, count) as (RawCard | RawQuestion | RawNote)[];
	const problems = raw.map((it) => itemProblem(kind, it, sent));

	// Second call: are the items backed by their passages (and, for questions, keyed right and unambiguous)?
	const checkable = raw.map((it, i) => ({ it, i })).filter(({ i }) => !problems[i]);
	const verdicts = new Map<number, { verdict: string; note: string }>();
	if (checkable.length) {
		const used = new Set(checkable.flatMap(({ it }) => it.sources));
		const block = sourcesBlock(passages.filter((p) => used.has(p.sid)));
		const list = checkable.map(({ it }, k) => `${k + 1}. ${statementFor(kind, it)}\n   Passages: ${it.sources.join(', ')}`).join('\n');
		try {
			const check = await complete({
				feature: 'check',
				system: kind === 'question' ? QUESTION_CHECK_SYSTEM : CHECK_SYSTEM,
				schema: (kind === 'question' ? QUESTION_CHECK_SCHEMA : CHECK_SCHEMA) as unknown as Record<string, unknown>,
				effort: 'low',
				maxTokens: 6000,
				messages: [{ role: 'user', content: `${block}\n\n${kind === 'question' ? 'Questions' : 'Statements'}:\n${list}` }]
			});
			for (const v of (check.json as { verdicts?: { index: number; verdict: string; note: string }[] })?.verdicts ?? []) {
				const target = checkable[v.index - 1];
				if (target) verdicts.set(target.i, { verdict: v.verdict, note: v.note });
			}
		} catch {
			// Unchecked items are flagged below.
		}
	}

	const batchId = input.batchId ?? uuidv7();
	let flaggedCount = 0;
	const now = Date.now();
	raw.forEach((it, i) => {
		const v = verdicts.get(i);
		const okVerdict = v && (v.verdict === 'supported' || v.verdict === 'ok');
		const notes: string[] = [];
		if (problems[i]) notes.push(`This item ${problems[i]}.`);
		else if (!v) notes.push('The support check couldn’t run for this item.');
		else if (!okVerdict) notes.push(v.verdict === 'wrong_key' ? `The answer key looks wrong: ${v.note}` : v.verdict === 'ambiguous' ? `Possibly ambiguous: ${v.note}` : `Not fully backed by its passages: ${v.note}`);
		const flagged = !!problems[i] || !okVerdict;
		if (flagged) flaggedCount++;
		const claim = { text: statementFor(kind, it), sources: it.sources.filter((s) => sent.has(s)).map((s) => Number(s.slice(1))), kind: 'content' as const, support: (okVerdict ? 'supported' : v?.verdict === 'partial' ? 'partial' : 'unsupported') as 'supported' | 'partial' | 'unsupported' };
		const { citations } = buildCitations('', [claim], passages);
		const content: Record<string, unknown> =
			kind === 'card'
				? (() => {
						const c = it as RawCard;
						return c.type === 'cloze' ? { type: 'cloze', text: c.text, extra: c.back && c.back !== c.text ? c.back : '' } : { type: 'basic', front: c.front, back: c.back };
					})()
				: kind === 'question'
					? { stem: (it as RawQuestion).stem, choices: (it as RawQuestion).choices, answer: (it as RawQuestion).answer, explanation: (it as RawQuestion).explanation }
					: { title: (it as RawNote).title, body: (it as RawNote).body };
		db()
			.insert(generatedItem)
			.values({
				id: uuidv7(),
				batchId,
				kind,
				content,
				sources: citations,
				status: 'pending',
				flagged,
				checks: { reference: !problems[i], support: v?.verdict ?? 'unchecked', notes },
				documentId: input.documentId,
				sectionId,
				aamcCode,
				provider: res.provider,
				model: res.model,
				createdAt: now,
				updatedAt: now
			})
			.run();
	});
	return { batchId, created: raw.length, flagged: flaggedCount };
}

registerJobHandler('ai_generate', async (row) => {
	const p = row.payload as { documentId: string; sectionId?: string | null; pageStart?: number; pageEnd?: number; kind: GenKind; count: number; batchId: string };
	// A rerun after an interruption starts the batch over.
	db().delete(generatedItem).where(and(eq(generatedItem.batchId, p.batchId), eq(generatedItem.status, 'pending'))).run();
	await generateItems(p);
});

export function startGeneration(input: { documentId: string; sectionId?: string | null; pageStart?: number; pageEnd?: number; kind: GenKind; count: number }) {
	const batchId = uuidv7();
	const jobId = enqueueJob('ai_generate', { ...input, batchId });
	return { batchId, jobId };
}

// ------------------------------------------------------------ approvals

export function pendingItems() {
	return db()
		.select()
		.from(generatedItem)
		.where(eq(generatedItem.status, 'pending'))
		.orderBy(desc(generatedItem.createdAt), asc(generatedItem.id))
		.all();
}

export function pendingCount() {
	return (sqlite().prepare(`SELECT count(*) AS n FROM generated_item WHERE status = 'pending'`).get() as { n: number }).n;
}

function firstAnchor(sources: Citation[]) {
	return sources.find((s) => s.anchorId)?.anchorId ?? null;
}

/** Approves an item (optionally with the owner's edits): it becomes a real card, question or note, marked as AI-made. */
export function approveItem(id: string, edits?: Record<string, unknown>) {
	const item = db().select().from(generatedItem).where(eq(generatedItem.id, id)).get();
	if (!item || item.status !== 'pending') throw new GenerateError('That item was already handled.');
	const c = { ...item.content, ...(edits ?? {}) } as Record<string, unknown>;
	const anchorId = firstAnchor(item.sources);
	let resultRef: string;
	if (item.kind === 'card') {
		const isCloze = c.type === 'cloze';
		const r = createNote({
			kind: isCloze ? 'cloze' : 'basic',
			fields: isCloze ? { Text: String(c.text ?? ''), 'Back Extra': String(c.extra ?? '') } : { Front: String(c.front ?? ''), Back: String(c.back ?? '') },
			aamcCode: item.aamcCode,
			tags: ['ai-generated'],
			anchorId,
			origin: 'ai'
		});
		resultRef = r.noteId;
	} else if (item.kind === 'question') {
		const choices = Array.isArray(c.choices) ? (c.choices as unknown[]).map(String).slice(0, 4) : [];
		const answer = Number(c.answer);
		if (choices.length !== 4 || !(answer >= 0 && answer < 4)) throw new GenerateError('A question needs four choices and an answer.');
		resultRef = uuidv7();
		const now = Date.now();
		db()
			.insert(question)
			.values({
				id: resultRef,
				stem: String(c.stem ?? ''),
				choices,
				answer: String(answer),
				explanation: String(c.explanation ?? ''),
				origin: 'ai',
				aamcCode: item.aamcCode,
				anchorId,
				sources: item.sources.map((s) => s.anchorId).filter((x): x is string => !!x),
				documentId: item.documentId,
				approvalStatus: 'approved',
				createdAt: now,
				updatedAt: now
			})
			.run();
	} else {
		const body = `**${String(c.title ?? 'Summary')}**\n\n${String(c.body ?? '')}\n\n_AI-generated from your book; approved by you._`;
		resultRef = createAnnotation({ anchorId, documentId: item.documentId, body });
		db().update(annotation).set({ origin: 'ai' }).where(eq(annotation.id, resultRef)).run();
	}
	db().update(generatedItem).set({ status: 'approved', content: c, resultRef, updatedAt: Date.now() }).where(eq(generatedItem.id, id)).run();
	return resultRef;
}

export function discardItem(id: string) {
	db().update(generatedItem).set({ status: 'discarded', updatedAt: Date.now() }).where(and(eq(generatedItem.id, id), eq(generatedItem.status, 'pending'))).run();
}

/** Approves every item in the list that passed its checks. Flagged items are left for one-by-one review. */
export function approveUnflagged(ids: string[]) {
	const rows = ids.length ? db().select().from(generatedItem).where(inArray(generatedItem.id, ids)).all() : [];
	let n = 0;
	for (const r of rows) {
		if (r.flagged || r.status !== 'pending') continue;
		approveItem(r.id);
		n++;
	}
	return n;
}

// ------------------------------------------------------------------ quiz

export function quizQuestions(opts: { documentId?: string | null; aamcCode?: string | null; limit?: number } = {}) {
	const where = [`q.deleted_at IS NULL`, `q.approval_status = 'approved'`, `json_array_length(q.choices) = 4`];
	const params: unknown[] = [];
	if (opts.documentId) {
		where.push('q.document_id = ?');
		params.push(opts.documentId);
	}
	if (opts.aamcCode) {
		where.push('q.aamc_code = ?');
		params.push(opts.aamcCode);
	}
	return sqlite()
		.prepare(
			`SELECT q.id, q.stem, q.choices, q.answer, q.explanation, q.aamc_code, q.anchor_id, q.document_id, q.origin,
			        (SELECT count(*) FROM attempt a WHERE a.question_id = q.id) AS attempts,
			        (SELECT max(attempted_at) FROM attempt a WHERE a.question_id = q.id) AS last
			 FROM question q WHERE ${where.join(' AND ')} ORDER BY attempts, last, q.created_at LIMIT ?`
		)
		.all(...params, opts.limit ?? 20)
		.map((r) => {
			const row = r as { id: string; stem: string; choices: string; answer: string; explanation: string | null; aamc_code: string | null; anchor_id: string | null; document_id: string | null; origin: string; attempts: number };
			return { ...row, choices: JSON.parse(row.choices) as string[], answer: Number(row.answer) };
		});
}

export function recordQuizAnswer(questionId: string, choice: number, timeMs: number) {
	const q = db().select().from(question).where(eq(question.id, questionId)).get();
	if (!q || q.deletedAt) throw new GenerateError('That question no longer exists.');
	const correct = Number(q.answer) === choice;
	const prior = (sqlite().prepare('SELECT count(*) AS n FROM attempt WHERE question_id = ?').get(questionId) as { n: number }).n;
	const now = Date.now();
	db()
		.insert(attempt)
		.values({
			id: uuidv7(),
			questionId,
			source: 'quiz',
			attemptNumber: prior + 1,
			answer: String(choice),
			correct,
			timeMs: Math.max(0, Math.min(Math.floor(timeMs) || 0, 3_600_000)),
			aamcCode: q.aamcCode,
			skillCode: q.skillCode,
			attemptedAt: now,
			studyDay: studyDayFor(now),
			createdAt: now
		})
		.run();
	return { correct, answer: Number(q.answer), explanation: q.explanation ?? '' };
}
