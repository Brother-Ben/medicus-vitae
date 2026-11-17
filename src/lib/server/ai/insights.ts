import { and, desc, eq } from 'drizzle-orm';
import { isCategoryCode } from '../../aamc';
import { studySnapshot } from '../dashboard';
import { db } from '../db';
import { aiSummary, docSection, document } from '../db/schema';
import { uuidv7 } from '../ids';
import { createAnnotation } from '../reading';
import { sectionPassages } from './generate';
import { SOURCE_RULES, sourcesBlock } from './prompts';
import { complete, type AiResponse } from './providers';
import { buildCitations } from './tutor';

// The AI coach on Today: a weekly recap, what to work on next, patterns in the
// mistake journal, and chapter summaries from the owner's books. Each one runs
// only when asked (it uses the owner's AI allowance) and is kept until asked
// again. The coach sees a short summary of study data, never whole books;
// chapter summaries see that chapter's passages and must cite them.

export type InsightKind = 'recap' | 'suggest' | 'mistakes' | 'chapter';

export class InsightError extends Error {}

const COACH = `You are a calm, encouraging MCAT study coach inside the student's own study app.
You get a JSON summary of their study data. Use only that data: don't invent numbers, dates, scores or topics, and say so when there's too little data to tell.
Write in plain, friendly language for a busy student: short sentences, no jargon, no filler, no medical advice.
Refer to AAMC content categories by code and name when the data has them (for example "1D Bioenergetics").`;

const RECAP_SCHEMA = {
	type: 'object',
	properties: {
		headline: { type: 'string' },
		summary: { type: 'string' },
		wins: { type: 'array', items: { type: 'string' } },
		watch: { type: 'array', items: { type: 'string' } }
	},
	required: ['headline', 'summary', 'wins', 'watch'],
	additionalProperties: false
};

const SUGGEST_SCHEMA = {
	type: 'object',
	properties: {
		summary: { type: 'string' },
		items: {
			type: 'array',
			items: {
				type: 'object',
				properties: {
					title: { type: 'string' },
					why: { type: 'string' },
					kind: { type: 'string', enum: ['reviews', 'new', 'category', 'mistakes', 'reading', 'full_length', 'rest', 'other'] },
					aamcCode: { type: 'string' },
					minutes: { type: 'number' }
				},
				required: ['title', 'why', 'kind', 'aamcCode', 'minutes'],
				additionalProperties: false
			}
		}
	},
	required: ['summary', 'items'],
	additionalProperties: false
};

const MISTAKES_SCHEMA = {
	type: 'object',
	properties: {
		summary: { type: 'string' },
		patterns: {
			type: 'array',
			items: {
				type: 'object',
				properties: { pattern: { type: 'string' }, evidence: { type: 'string' }, fix: { type: 'string' } },
				required: ['pattern', 'evidence', 'fix'],
				additionalProperties: false
			}
		}
	},
	required: ['summary', 'patterns'],
	additionalProperties: false
};

const CHAPTER_SCHEMA = {
	type: 'object',
	properties: {
		title: { type: 'string' },
		body: { type: 'string' },
		keyTerms: { type: 'array', items: { type: 'string' } }
	},
	required: ['title', 'body', 'keyTerms'],
	additionalProperties: false
};

function save(kind: InsightKind, scope: string, text: string, data: Record<string, unknown>, r: AiResponse) {
	const id = uuidv7();
	db()
		.insert(aiSummary)
		.values({ id, kind, scope, text, data, provider: r.provider, model: r.model, createdAt: Date.now() })
		.run();
	return latestInsight(kind, scope)!;
}

export function latestInsight(kind: InsightKind, scope = '') {
	const row = db()
		.select()
		.from(aiSummary)
		.where(and(eq(aiSummary.kind, kind), eq(aiSummary.scope, scope)))
		.orderBy(desc(aiSummary.createdAt))
		.limit(1)
		.get();
	return row ? { id: row.id, kind: row.kind as InsightKind, scope: row.scope, text: row.text, data: (row.data ?? {}) as Record<string, unknown>, createdAt: row.createdAt, model: row.model } : null;
}

export type Insight = NonNullable<ReturnType<typeof latestInsight>>;

const asStrings = (v: unknown) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 6) : []);

export async function weeklyRecap(): Promise<Insight> {
	const snap = studySnapshot();
	const r = await complete({
		feature: 'insights',
		system: `${COACH}\n\nTask [insights:recap]: a short recap of the last 7 days compared with the 7 before. "headline": one upbeat line (under 12 words). "summary": 2–4 sentences. "wins": up to 3 things that went well. "watch": up to 3 things to keep an eye on. If they barely studied, be kind and practical, not guilt-tripping.`,
		messages: [{ role: 'user', content: `Study data:\n${JSON.stringify(snap)}` }],
		schema: RECAP_SCHEMA,
		maxTokens: 900,
		effort: 'low'
	});
	const j = (r.json ?? {}) as Record<string, unknown>;
	const headline = String(j.headline ?? '').trim() || 'Your week';
	return save('recap', '', `${headline}\n\n${String(j.summary ?? '').trim()}`, { headline, summary: String(j.summary ?? ''), wins: asStrings(j.wins), watch: asStrings(j.watch) }, r);
}

export async function studySuggestions(): Promise<Insight> {
	const snap = studySnapshot();
	const r = await complete({
		feature: 'insights',
		system: `${COACH}\n\nTask [insights:suggest]: suggest what to work on today, as 2–5 items in priority order. Due flashcard reviews usually come first when there are many. Use "kind": reviews (due cards), new (new cards), category (study one AAMC category; put its code in "aamcCode", e.g. "1D"), mistakes (fix open mistakes), reading (keep reading their book), full_length (a practice test, only when test day is near and the last one was a while ago), rest (if they've been overdoing it), other. "aamcCode" is "" when it doesn't apply. "minutes": a realistic estimate. "why": one sentence that points at the data. "summary": one or two sentences.`,
		messages: [{ role: 'user', content: `Study data:\n${JSON.stringify(snap)}` }],
		schema: SUGGEST_SCHEMA,
		maxTokens: 1100,
		effort: 'low'
	});
	const j = (r.json ?? {}) as { summary?: unknown; items?: unknown[] };
	const kinds = ['reviews', 'new', 'category', 'mistakes', 'reading', 'full_length', 'rest', 'other'];
	const items = (Array.isArray(j.items) ? j.items : []).slice(0, 6).map((x) => {
		const i = (x ?? {}) as Record<string, unknown>;
		const code = String(i.aamcCode ?? '').trim().toUpperCase();
		return {
			title: String(i.title ?? '').slice(0, 140),
			why: String(i.why ?? '').slice(0, 400),
			kind: kinds.includes(String(i.kind)) ? String(i.kind) : 'other',
			aamcCode: isCategoryCode(code) ? code : null,
			minutes: Math.max(5, Math.min(240, Math.round(Number(i.minutes) || 20)))
		};
	});
	return save('suggest', '', String(j.summary ?? '').trim(), { summary: String(j.summary ?? ''), items }, r);
}

export async function mistakePatterns(): Promise<Insight> {
	const snap = studySnapshot();
	if (snap.mistakes.open + snap.mistakes.resolved < 3) throw new InsightError('Log at least three mistakes first; patterns need a few to compare.');
	const r = await complete({
		feature: 'insights',
		system: `${COACH}\n\nTask [insights:mistakes]: look at the mistake journal data (reasons, categories, recent summaries) and find up to 4 patterns. For each: "pattern" (short name), "evidence" (what in the data shows it), "fix" (one concrete habit or step to try). "summary": one or two sentences. If there's no clear pattern, say so and give one general tip.`,
		messages: [{ role: 'user', content: `Mistake data:\n${JSON.stringify({ mistakes: snap.mistakes, weakAreas: snap.weakAreas, fullLengths: snap.fullLengths })}` }],
		schema: MISTAKES_SCHEMA,
		maxTokens: 1100,
		effort: 'low'
	});
	const j = (r.json ?? {}) as { summary?: unknown; patterns?: unknown[] };
	const patterns = (Array.isArray(j.patterns) ? j.patterns : []).slice(0, 5).map((x) => {
		const p = (x ?? {}) as Record<string, unknown>;
		return { pattern: String(p.pattern ?? ''), evidence: String(p.evidence ?? ''), fix: String(p.fix ?? '') };
	});
	return save('mistakes', '', String(j.summary ?? '').trim(), { summary: String(j.summary ?? ''), patterns }, r);
}

/** A summary of one chapter from its own passages, with numbered citations back to the pages. */
export async function chapterSummary(sectionId: string): Promise<Insight> {
	const s = db().select().from(docSection).where(eq(docSection.id, sectionId)).get();
	if (!s) throw new InsightError('That chapter no longer exists.');
	const doc = db().select().from(document).where(eq(document.id, s.documentId)).get();
	if (!doc) throw new InsightError('That book no longer exists.');
	const passages = sectionPassages(s.documentId, s.pageStart, Math.min(s.pageEnd, s.pageStart + 40));
	const r = await complete({
		feature: 'insights',
		system: `You write concise MCAT study summaries of one chapter for quick review.\n\n${SOURCE_RULES}\n\nTask [insights:chapter]: "title": a short title. "body": Markdown, 150–350 words: the key ideas as short bullet points grouped under 2–4 bold headings, each bullet cited like [S3]. "keyTerms": up to 8 terms to know. Only what the sources say.`,
		messages: [{ role: 'user', content: `Chapter: ${s.title} (${doc.title}, pages ${s.pageStart}–${s.pageEnd})\n\n${sourcesBlock(passages)}` }],
		schema: CHAPTER_SCHEMA,
		maxTokens: 1600,
		effort: 'medium'
	});
	const j = (r.json ?? {}) as { title?: unknown; body?: unknown; keyTerms?: unknown };
	const built = buildCitations(String(j.body ?? ''), [], passages);
	if (!built.text.trim()) throw new InsightError('The AI didn’t return a summary. Try again.');
	return save(
		'chapter',
		sectionId,
		built.text,
		{ title: String(j.title ?? s.title), keyTerms: asStrings(j.keyTerms), citations: built.citations, documentId: doc.id, bookTitle: doc.title, section: s.title, pageStart: s.pageStart, pageEnd: s.pageEnd, savedNoteId: null },
		r
	);
}

/** Keeps a chapter summary as a note on the book (marked as AI-made; never used as the tutor's evidence). */
export function saveSummaryAsNote(insightId: string) {
	const row = db().select().from(aiSummary).where(eq(aiSummary.id, insightId)).get();
	if (!row || row.kind !== 'chapter') throw new InsightError('Summary not found.');
	const d = (row.data ?? {}) as { title?: string; documentId?: string; section?: string; pageStart?: number; pageEnd?: number; citations?: { n: number; page: number | null }[]; savedNoteId?: string | null };
	if (d.savedNoteId) return d.savedNoteId;
	const pages = (d.citations ?? []).map((c) => `[${c.n}] p. ${c.page ?? '?'}`).join(' · ');
	const body = `### ${d.title ?? 'Chapter summary'}\n\n*AI summary of ${d.section ?? 'this chapter'} (pages ${d.pageStart}–${d.pageEnd}).*\n\n${row.text}${pages ? `\n\n<small>Sources: ${pages}</small>` : ''}`;
	const noteId = createAnnotation({ documentId: d.documentId ?? null, body });
	db().update(aiSummary).set({ data: { ...d, savedNoteId: noteId } }).where(eq(aiSummary.id, insightId)).run();
	// Mark it as AI-made, like approved generated notes.
	db().$client.prepare("UPDATE annotation SET origin = 'ai' WHERE id = ?").run(noteId);
	return noteId;
}
