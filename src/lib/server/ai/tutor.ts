import { and, asc, desc, eq, isNull } from 'drizzle-orm';
import { kindForNoteType, noteText } from '../../cards';
import { normalizeQuote, rectsForRange } from '../../pdf/pagetext.js';
import { db, sqlite } from '../db';
import { anchor, card, chatMessage, chatThread, note, type ChatContext, type Citation, type ClaimCheck } from '../db/schema';
import { uuidv7 } from '../ids';
import { anchorView, createAnchor } from '../reading';
import { CHECK_SCHEMA, CHECK_SYSTEM, RESEARCH_SYSTEM, sourcesBlock, TUTOR_SCHEMA, tutorSystem } from './prompts';
import { AiError, complete, research, type AiMessage, type AiResponse } from './providers';
import { passageLabel, retrieve, type Passage } from './retrieval';

// The grounded tutor (AI-01, AI-03; spec 12.4): retrieve passages from the
// owner's material, send only those (each with an id) and the question, require
// citations, check every cited id was actually sent (rule-based), then ask a
// second call whether each passage really backs its claim. Answers that fail a
// check are shown flagged, never silently. If the material doesn't cover the
// question, the tutor says so.

/** guide and explain answer only from the owner's material; research searches the web. */
export type TutorMode = 'guide' | 'explain' | 'research';

export interface SentPassage extends Passage {
	sid: string;
}

export interface MessageView {
	id: string;
	role: 'user' | 'assistant';
	text: string;
	mode: string | null;
	status: string;
	citations: Citation[];
	claims: ClaimCheck[];
	createdAt: number;
}

interface TutorJson {
	status: 'answered' | 'not_found';
	answer: string;
	claims: { text: string; sources: string[]; kind: 'content' | 'strategy' }[];
	suggestion: string;
}

const MARKER = /\[(S\d+(?:\s*[,;]\s*S\d+)*)\]/g;

function asTutorJson(v: unknown): TutorJson {
	const o = (v ?? {}) as Record<string, unknown>;
	return {
		status: o.status === 'not_found' ? 'not_found' : 'answered',
		answer: typeof o.answer === 'string' ? o.answer : '',
		claims: Array.isArray(o.claims)
			? (o.claims as Record<string, unknown>[]).map((c) => ({
					text: String(c.text ?? ''),
					sources: Array.isArray(c.sources) ? (c.sources as unknown[]).map(String) : [],
					kind: c.kind === 'strategy' ? 'strategy' : 'content'
				}))
			: [],
		suggestion: typeof o.suggestion === 'string' ? o.suggestion : ''
	};
}

export function citedIds(text: string): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(MARKER)) for (const id of m[1].split(/\s*[,;]\s*/)) out.push(id.trim());
	return out;
}

/** Rule-based reference check: ids cited in the answer and claims that weren't sent, and content claims with no valid source. */
export function referenceProblems(j: TutorJson, sent: Set<string>) {
	const badMarkers = [...new Set(citedIds(j.answer).filter((id) => !sent.has(id)))];
	const badClaims = j.claims.filter((c) => c.sources.some((s) => !sent.has(s)) || (c.kind === 'content' && !c.sources.some((s) => sent.has(s))));
	return { badMarkers, badClaims, ok: !badMarkers.length && !badClaims.length };
}

// ---------------------------------------------------------- passages

function passageFromAnchor(anchorId: string): Passage | null {
	const a = anchorView(anchorId);
	if (!a || !a.exact.trim()) return null;
	const row = db().select().from(anchor).where(eq(anchor.id, anchorId)).get();
	return {
		chunkId: -1,
		kind: a.kind === 'region' ? 'figure' : 'page',
		provenance: 'original',
		docId: a.documentId,
		versionId: a.versionId,
		page: a.page,
		textStart: row?.textStart ?? null,
		textEnd: row?.textEnd ?? null,
		rects: a.rects,
		refId: anchorId,
		section: a.sectionTitle,
		text: a.exact,
		label: passageLabel({ kind: a.kind === 'region' ? 'figure' : 'page', page: a.page, section: a.sectionTitle, provenance: 'original' }, a.documentTitle),
		score: 1
	};
}

function passageFromCard(cardId: string): Passage | null {
	const c = db().select().from(card).where(eq(card.id, cardId)).get();
	if (!c) return null;
	const n = db().select().from(note).where(eq(note.id, c.noteId)).get();
	if (!n || n.deletedAt || n.origin === 'ai') return null;
	const text = noteText(kindForNoteType(n.noteTypeId), n.fields);
	if (!text) return null;
	const provenance = n.origin === 'anki' ? 'anki' : 'owner';
	return {
		chunkId: -1,
		kind: 'card',
		provenance,
		docId: null,
		versionId: null,
		page: null,
		textStart: null,
		textEnd: null,
		rects: null,
		refId: n.id,
		section: null,
		text,
		label: passageLabel({ kind: 'card', page: null, section: null, provenance }, null),
		score: 1
	};
}

/** Context first (the selection or card being asked about), then the best matches from the library. */
export async function gatherPassages(question: string, context: ChatContext | null, k = 8): Promise<SentPassage[]> {
	const pinned: Passage[] = [];
	if (context?.anchorId) {
		const p = passageFromAnchor(context.anchorId);
		if (p) pinned.push(p);
	}
	if (context?.cardId) {
		const p = passageFromCard(context.cardId);
		if (p) pinned.push(p);
	}
	const query = [question, ...pinned.map((p) => p.text.slice(0, 400))].join('\n');
	const found = await retrieve(query, { k: k + pinned.length, documentId: context?.documentId ?? null, page: context?.page ?? null });
	const all: Passage[] = [...pinned];
	for (const p of found) {
		if (all.length >= k) break;
		const dup = all.some((x) => x.refId && x.refId === p.refId && x.kind === p.kind) || all.some((x) => normalizeQuote(x.text) === normalizeQuote(p.text));
		if (!dup) all.push(p);
	}
	return all.map((p, i) => ({ ...p, sid: `S${i + 1}` }));
}

// ------------------------------------------------------------- citations

/** A permanent anchor for a cited book passage, so the link opens the reader at that spot. */
function anchorFor(p: SentPassage): string | null {
	if (p.chunkId === -1 && p.refId && (p.kind === 'page' || p.kind === 'figure')) return p.refId; // already an anchor
	if (!p.docId || !p.versionId || !p.page) return null;
	try {
		if (p.kind === 'figure' && p.rects?.length) {
			if (p.refId && p.chunkId !== -1 && sqlite().prepare('SELECT 1 FROM anchor WHERE id = ?').get(p.refId)) return p.refId;
			return createAnchor({ documentId: p.docId, versionId: p.versionId, page: p.page, kind: 'region', rects: p.rects, exact: p.text });
		}
		if (p.kind === 'page' && p.textStart !== null && p.textEnd !== null) {
			const row = sqlite().prepare('SELECT text, items FROM doc_page WHERE version_id = ? AND page_number = ?').get(p.versionId, p.page) as
				| { text: string; items: string }
				| undefined;
			if (!row) return null;
			const rects = rectsForRange(JSON.parse(row.items), p.textStart, p.textEnd);
			if (!rects.length) return null;
			return createAnchor({
				documentId: p.docId,
				versionId: p.versionId,
				page: p.page,
				kind: 'text',
				rects,
				textStart: p.textStart,
				textEnd: p.textEnd,
				exact: row.text.slice(p.textStart, p.textEnd),
				prefix: row.text.slice(Math.max(0, p.textStart - 64), p.textStart),
				suffix: row.text.slice(p.textEnd, p.textEnd + 64)
			});
		}
	} catch {
		return null;
	}
	return null;
}

const SUPPORT_RANK = { unsupported: 3, partial: 2, unchecked: 1, supported: 0 } as const;

export function buildCitations(answer: string, claims: ClaimCheck[], passages: SentPassage[]) {
	const order: string[] = [];
	for (const id of citedIds(answer)) if (!order.includes(id)) order.push(id);
	for (const c of claims) for (const n of c.sources) {
		const sid = `S${n}`;
		if (!order.includes(sid)) order.push(sid);
	}
	const bySid = new Map(passages.map((p) => [p.sid, p]));
	const number = new Map<string, number>();
	const citations: Citation[] = [];
	for (const sid of order) {
		const p = bySid.get(sid);
		if (!p) continue;
		const n = citations.length + 1;
		number.set(sid, n);
		const citing = claims.filter((c) => c.sources.includes(Number(sid.slice(1))));
		let support: Citation['support'] = citing.length ? 'supported' : 'unchecked';
		for (const c of citing) {
			const s = c.support === 'uncited' ? 'unchecked' : c.support;
			if (SUPPORT_RANK[s] > SUPPORT_RANK[support]) support = s;
		}
		citations.push({
			n,
			kind: p.kind,
			anchorId: p.kind === 'page' || p.kind === 'figure' ? anchorFor(p) : null,
			documentId: p.docId,
			page: p.page,
			refId: p.kind === 'card' || p.kind === 'annotation' ? p.refId : null,
			label: p.label,
			exact: p.text.slice(0, 2000),
			support
		});
	}
	const text = answer.replace(MARKER, (_m, ids: string) =>
		ids
			.split(/\s*[,;]\s*/)
			.map((id) => (number.has(id.trim()) ? `[${number.get(id.trim())}]` : ''))
			.join('')
	);
	const renumbered = claims.map((c) => ({ ...c, sources: c.sources.map((s) => number.get(`S${s}`) ?? 0).filter(Boolean) }));
	return { text, citations, claims: renumbered };
}

// -------------------------------------------------------------- checks

/** Second model call: does each cited passage back its claim? */
export async function supportCheck(claims: { text: string; sources: string[] }[], passages: SentPassage[]): Promise<({ verdict: 'supported' | 'partial' | 'unsupported'; note: string } | null)[]> {
	const items = claims.map((c, i) => ({ i, c })).filter(({ c }) => c.sources.length);
	if (!items.length) return claims.map(() => null);
	const used = new Set(items.flatMap(({ c }) => c.sources));
	const block = sourcesBlock(passages.filter((p) => used.has(p.sid)));
	const list = items.map(({ c }, k) => `${k + 1}. ${c.text}\n   Passages: ${c.sources.join(', ')}`).join('\n');
	let res: AiResponse;
	try {
		res = await complete({
			feature: 'check',
			system: CHECK_SYSTEM,
			schema: CHECK_SCHEMA as unknown as Record<string, unknown>,
			effort: 'low',
			maxTokens: 4000,
			messages: [{ role: 'user', content: `${block}\n\nStatements:\n${list}` }]
		});
	} catch (err) {
		if (err instanceof AiError && (err.code === 'usage_limit' || err.code === 'cap_reached')) throw err;
		return claims.map(() => null);
	}
	const verdicts = ((res.json as { verdicts?: { index: number; verdict: string; note: string }[] })?.verdicts ?? []).filter((v) => Number.isInteger(v.index));
	const out: ({ verdict: 'supported' | 'partial' | 'unsupported'; note: string } | null)[] = claims.map(() => null);
	items.forEach(({ i }, k) => {
		const v = verdicts.find((x) => x.index === k + 1);
		if (v && ['supported', 'partial', 'unsupported'].includes(v.verdict)) out[i] = { verdict: v.verdict as 'supported' | 'partial' | 'unsupported', note: v.note ?? '' };
	});
	return out;
}

// ------------------------------------------------------------ threads

function toView(m: typeof chatMessage.$inferSelect): MessageView {
	return { id: m.id, role: m.role as 'user' | 'assistant', text: m.text, mode: m.mode, status: m.status, citations: m.citations, claims: m.claims, createdAt: m.createdAt };
}

export function listThreads(limit = 50) {
	return db()
		.select()
		.from(chatThread)
		.where(isNull(chatThread.deletedAt))
		.orderBy(desc(chatThread.updatedAt))
		.limit(limit)
		.all()
		.map((t) => ({ id: t.id, title: t.title, mode: t.mode, context: t.context, updatedAt: t.updatedAt }));
}

export function getThread(id: string) {
	const t = db().select().from(chatThread).where(and(eq(chatThread.id, id), isNull(chatThread.deletedAt))).get();
	if (!t) return null;
	const messages = db().select().from(chatMessage).where(eq(chatMessage.threadId, id)).orderBy(asc(chatMessage.createdAt), asc(chatMessage.id)).all();
	return { id: t.id, title: t.title, mode: t.mode as TutorMode, context: t.context, updatedAt: t.updatedAt, messages: messages.map(toView) };
}

export function deleteThread(id: string) {
	db().update(chatThread).set({ deletedAt: Date.now(), updatedAt: Date.now() }).where(eq(chatThread.id, id)).run();
}

function historyFor(threadId: string): AiMessage[] {
	const rows = db().select().from(chatMessage).where(eq(chatMessage.threadId, threadId)).orderBy(desc(chatMessage.createdAt)).limit(6).all().reverse();
	return rows
		.filter((m) => m.status !== 'error')
		.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.role === 'assistant' ? m.text.replace(/\[\d+\]/g, '') : m.text }));
}

// ---------------------------------------------------------------- ask

export interface AskInput {
	threadId?: string | null;
	question: string;
	mode?: TutorMode;
	context?: ChatContext | null;
}

export class TutorError extends Error {}

export interface TutorAnswer {
	status: 'answered' | 'not_found' | 'flagged';
	text: string;
	citations: Citation[];
	claims: ClaimCheck[];
	provider: string;
	model: string;
}

/** The grounded answer for a question and its passages (no saving). Used by the tutor and the quality check. */
export async function runTutor(question: string, passages: SentPassage[], mode: Exclude<TutorMode, 'research'>, history: AiMessage[] = []): Promise<TutorAnswer> {
	const sent = new Set(passages.map((p) => p.sid));
	const userTurn: AiMessage = { role: 'user', content: `${sourcesBlock(passages)}\n\nQuestion: ${question}` };
	const ask = (extra: AiMessage[] = []) =>
		complete({
			feature: 'tutor',
			system: tutorSystem(mode),
			schema: TUTOR_SCHEMA as unknown as Record<string, unknown>,
			effort: mode === 'explain' ? 'medium' : 'low',
			maxTokens: 6000,
			messages: [...history, userTurn, ...extra]
		});

	let res = await ask();
	let j = asTutorJson(res.json);
	let problems = referenceProblems(j, sent);
	if (!problems.ok) {
		// One retry with the problem spelled out; after that, flag what's still wrong.
		const valid = passages.length ? `${passages[0].sid}–${passages[passages.length - 1].sid}` : 'none';
		res = await ask([
			{ role: 'assistant', content: JSON.stringify(j) },
			{
				role: 'user',
				content: `Your answer cites ids that weren't provided${problems.badMarkers.length ? ` (${problems.badMarkers.join(', ')})` : ''}, or has content claims without a valid source. Valid ids: ${valid}. Remove anything the sources don't support, cite only valid ids, and return the corrected JSON.`
			}
		]);
		j = asTutorJson(res.json);
		problems = referenceProblems(j, sent);
	}

	// Strip citations to ids that were never sent; such claims count as uncited.
	const answer = j.answer.replace(MARKER, (m, ids: string) => {
		const keep = ids.split(/\s*[,;]\s*/).filter((id) => sent.has(id.trim()));
		return keep.length ? `[${keep.join(', ')}]` : '';
	});
	const claimsIn = j.claims.map((c) => ({ ...c, sources: c.sources.filter((s) => sent.has(s)) }));
	const verdicts = j.status === 'answered' ? await supportCheck(claimsIn.filter((c) => c.kind === 'content'), passages) : [];
	let vi = 0;
	const claims: ClaimCheck[] = claimsIn.map((c) => {
		const base = { text: c.text, sources: c.sources.map((s) => Number(s.slice(1))), kind: c.kind };
		if (c.kind === 'strategy') return { ...base, support: 'supported' as const };
		const v = j.status === 'answered' ? verdicts[vi++] : null;
		if (!c.sources.length) return { ...base, support: 'uncited' as const };
		return { ...base, support: v ? v.verdict : ('unchecked' as const), note: v?.note };
	});

	const built = buildCitations(answer, claims, passages);
	const flagged = j.status === 'answered' && (!problems.ok || built.claims.some((c) => c.kind === 'content' && c.support !== 'supported'));
	const status = j.status === 'not_found' ? 'not_found' : flagged ? 'flagged' : 'answered';
	const text = j.status === 'not_found' && j.suggestion.trim() ? `${built.text.trim()}\n\n${j.suggestion.trim()}` : built.text.trim();
	return { status, text: text || 'I couldn’t put together an answer from your material.', citations: built.citations, claims: built.claims, provider: res.provider, model: res.model };
}

const asMode = (m: unknown): TutorMode => (m === 'explain' || m === 'research' ? m : 'guide');

/**
 * Research mode: the question (and the passage the student is asking about, if
 * any) goes to the AI service's own web search. The answer cites web pages, is
 * shown as "From the web", and never counts as the student's material.
 */
export async function runResearch(question: string, context: ChatContext | null, history: AiMessage[] = []): Promise<TutorAnswer> {
	const pinned = context?.anchorId ? passageFromAnchor(context.anchorId) : context?.cardId ? passageFromCard(context.cardId) : null;
	const quoted = pinned ? `The student is reading this passage from their own material:\n<passage>\n${pinned.text.slice(0, 3000).replace(/<\/?passage>/gi, '')}\n</passage>\n\n` : '';
	const res = await research({ system: RESEARCH_SYSTEM, messages: [...history, { role: 'user', content: `${quoted}Question: ${question}` }], maxSearches: 5 });
	const citations: Citation[] = res.sources.map((s) => ({
		n: s.n,
		kind: 'web',
		anchorId: null,
		documentId: null,
		page: null,
		refId: null,
		label: s.title,
		exact: s.quote,
		url: s.url,
		support: 'unchecked'
	}));
	return {
		status: 'answered',
		text: res.text || 'I couldn’t find a reliable answer on the web.',
		citations,
		claims: [],
		provider: res.provider,
		model: res.model
	};
}

export async function askTutor(input: AskInput): Promise<{ threadId: string; user: MessageView; answer: MessageView }> {
	const question = String(input.question ?? '').trim();
	if (!question) throw new TutorError('Ask a question first.');
	if (question.length > 4000) throw new TutorError('That question is too long (4,000 characters at most).');
	const now = Date.now();
	let threadId = input.threadId ?? null;
	let context: ChatContext | null = input.context ?? null;
	let mode: TutorMode = asMode(input.mode);
	if (threadId) {
		const t = db().select().from(chatThread).where(eq(chatThread.id, threadId)).get();
		if (!t || t.deletedAt) throw new TutorError('That conversation no longer exists.');
		context = context ?? t.context;
		if (!input.mode) mode = asMode(t.mode);
	}
	const history = threadId ? historyFor(threadId) : [];
	const out = mode === 'research' ? await runResearch(question, context, history) : await runTutor(question, await gatherPassages(question, context), mode, history);

	const userMsg = { id: uuidv7(), threadId: '', role: 'user', mode, text: question, status: 'answered', citations: [], claims: [], provider: null, model: null, createdAt: now };
	const answerMsg = {
		id: uuidv7(),
		threadId: '',
		role: 'assistant',
		mode,
		text: out.text,
		status: out.status,
		citations: out.citations,
		claims: out.claims,
		provider: out.provider,
		model: out.model,
		createdAt: Date.now()
	};
	db().transaction((tx) => {
		if (!threadId) {
			threadId = uuidv7();
			tx.insert(chatThread)
				.values({ id: threadId, title: question.slice(0, 120), mode, context, createdAt: now, updatedAt: now })
				.run();
		} else {
			tx.update(chatThread).set({ mode, updatedAt: Date.now() }).where(eq(chatThread.id, threadId)).run();
		}
		userMsg.threadId = threadId;
		answerMsg.threadId = threadId;
		tx.insert(chatMessage).values(userMsg).run();
		tx.insert(chatMessage).values(answerMsg).run();
	});
	return {
		threadId: threadId!,
		user: toView(userMsg as typeof chatMessage.$inferSelect),
		answer: toView(answerMsg as typeof chatMessage.$inferSelect)
	};
}
