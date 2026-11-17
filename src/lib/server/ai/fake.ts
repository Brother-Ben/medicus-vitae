import type { AiRequest, AiResponse, ResearchRequest, ResearchResponse } from './providers';

/** Research mode in the browser tests: a canned answer with one web source. */
export async function fakeResearch(req: ResearchRequest): Promise<ResearchResponse> {
	const q = (/Question: ([\s\S]*)$/.exec(req.messages[req.messages.length - 1]?.content ?? '')?.[1] ?? '').trim();
	return {
		text: `A web answer about ${q || 'the question'} [1].`,
		sources: [{ n: 1, url: 'https://example.org/source', title: 'Example source', quote: 'An example sentence from the page.' }],
		provider: 'claude',
		model: 'test-ai',
		searches: 1,
		costUsd: 0
	};
}

// A stand-in AI service for the browser tests, switched on only with
// CORTEX_FAKE_AI=1 (never in normal use). It answers from the first passage
// that shares words with the question, so the tutor's whole path (retrieval,
// citations, checks, links back to the book) can be exercised without an account.

function sources(text: string) {
	return [...text.matchAll(/<source id="(S\d+)"[^>]*>\n([\s\S]*?)\n<\/source>/g)].map((m) => ({ sid: m[1], text: m[2] }));
}

export async function fakeComplete(req: AiRequest): Promise<AiResponse> {
	const last = req.messages[req.messages.length - 1]?.content ?? '';
	const src = sources(last);
	let json: unknown = {};
	if (req.feature === 'tutor') {
		const question = (/Question: ([\s\S]*)$/.exec(last)?.[1] ?? '').toLowerCase();
		const words = question.match(/[a-z]{4,}/g) ?? [];
		const best = src.map((s) => ({ s, score: words.filter((w) => s.text.toLowerCase().includes(w)).length })).sort((a, b) => b.score - a.score)[0];
		if (!best || best.score === 0) {
			json = { status: 'not_found', answer: 'That isn’t covered in your material.', claims: [], suggestion: 'Add a chapter that covers it, then ask again.' };
		} else {
			const sentence = best.s.text.split(/(?<=[.!?])\s+/)[0].trim();
			json = { status: 'answered', answer: `${sentence} [${best.s.sid}]`, claims: [{ text: sentence, sources: [best.s.sid], kind: 'content' }], suggestion: '' };
		}
	} else if (req.feature === 'check' || req.feature === 'quality') {
		const n = (last.match(/^\d+\. /gm) ?? []).length;
		const ok = /multiple-choice/.test(req.system) ? 'ok' : 'supported';
		json = { verdicts: Array.from({ length: n }, (_, i) => ({ index: i + 1, verdict: ok, note: '' })) };
		if (/connection test/i.test(req.system)) json = {};
	} else if (req.feature === 'insights') {
		const task = /\[insights:(\w+)\]/.exec(req.system)?.[1];
		if (task === 'recap') json = { headline: 'A steady week', summary: 'You studied on several days.', wins: ['Kept your streak'], watch: ['Reviews are piling up'] };
		else if (task === 'suggest') json = { summary: 'Start with due cards.', items: [{ title: 'Review due cards', why: 'Several are due.', kind: 'reviews', aamcCode: '', minutes: 20 }, { title: 'Study 1D', why: 'Weakest area.', kind: 'category', aamcCode: '1D', minutes: 25 }] };
		else if (task === 'mistakes') json = { summary: 'Mostly content gaps.', patterns: [{ pattern: 'Content gaps', evidence: 'Most mistakes', fix: 'Reread the passage first' }] };
		else json = { title: 'Summary', body: src.length ? `**Key ideas**\n\n- ${src[0].text.split(/(?<=[.!?])\s+/)[0].trim()} [${src[0].sid}]` : '', keyTerms: ['term'] };
	} else if (req.feature === 'generate') {
		const firstSentence = (s: string) => s.split(/(?<=[.!?])\s+/)[0].trim();
		if (/multiple-choice/.test(req.system)) {
			json = {
				items: src.slice(0, 1).map((s) => ({
					stem: `Which statement matches the passage?`,
					choices: [firstSentence(s.text), 'None of the passage applies.', 'The opposite of the passage.', 'Something unrelated.'],
					answer: 0,
					explanation: 'It is stated in the passage.',
					sources: [s.sid]
				}))
			};
		} else if (/study notes/.test(req.system)) {
			json = { items: src.slice(0, 1).map((s) => ({ title: 'Summary', body: firstSentence(s.text), sources: [s.sid] })) };
		} else {
			json = { items: src.slice(0, 2).map((s, i) => ({ type: 'basic', front: `Test question ${i + 1} from the passage`, back: firstSentence(s.text), text: '', sources: [s.sid] })) };
		}
	}
	return { text: JSON.stringify(json), json, provider: 'claude', model: 'test-ai', inputTokens: 10, outputTokens: 10, costUsd: 0 };
}
