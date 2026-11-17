import { pendingItems, quizQuestions } from '#lib/server/ai/generate.js';
import { getDocument } from '#lib/server/library.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends }) => {
	depends('app:queue');
	const items = pendingItems();
	const titles = new Map<string, string>();
	for (const i of items) if (i.documentId && !titles.has(i.documentId)) titles.set(i.documentId, getDocument(i.documentId)?.title ?? 'Book');
	return {
		items: items.map((i) => ({
			id: i.id,
			kind: i.kind as 'card' | 'question' | 'note',
			content: i.content,
			sources: i.sources,
			flagged: i.flagged,
			checks: i.checks,
			aamcCode: i.aamcCode,
			book: i.documentId ? (titles.get(i.documentId) ?? null) : null,
			createdAt: i.createdAt
		})),
		quizCount: quizQuestions({ limit: 1000 }).length
	};
};
