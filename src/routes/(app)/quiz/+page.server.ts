import { pendingCount, quizQuestions } from '#lib/server/ai/generate.js';
import { anchorViews, anchorLabel } from '#lib/server/reading.js';
import { getDocument } from '#lib/server/library.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url, depends }) => {
	depends('app:quiz');
	const documentId = url.searchParams.get('doc');
	const questions = quizQuestions({ documentId, limit: 20 });
	const anchors = anchorViews(questions.map((q) => q.anchor_id ?? ''));
	const all = quizQuestions({ limit: 1000 });
	const books = [...new Set(all.map((q) => q.document_id).filter((x): x is string => !!x))].map((id) => ({ id, title: getDocument(id)?.title ?? 'Book' }));
	return {
		documentId,
		books,
		total: all.length,
		pending: pendingCount(),
		questions: questions.map((q) => {
			const a = q.anchor_id ? anchors.get(q.anchor_id) : null;
			return {
				id: q.id,
				stem: q.stem,
				choices: q.choices,
				aamcCode: q.aamc_code,
				attempts: q.attempts,
				source: a ? { label: anchorLabel(a), href: a.available ? `/library/${a.documentId}/read?anchor=${a.id}` : null } : null,
				ai: q.origin === 'ai'
			};
		})
	};
};
