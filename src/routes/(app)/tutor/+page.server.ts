import type { ChatContext } from '#lib/server/db/schema.js';
import { pendingCount, quizQuestions } from '#lib/server/ai/generate.js';
import { activeProviderId, aiConnected, canResearch, modelFor, PROVIDER_LABELS } from '#lib/server/ai/providers.js';
import { getThread, listThreads } from '#lib/server/ai/tutor.js';
import { cardsByIds, reviewCard } from '#lib/server/cards.js';
import { getDocument } from '#lib/server/library.js';
import { notePreview } from '#lib/cards.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url, depends }) => {
	depends('app:tutor');
	const connected = aiConnected();
	const provider = activeProviderId();
	const threadId = url.searchParams.get('t');
	const thread = threadId ? getThread(threadId) : null;

	// Starting a conversation from elsewhere: ?q= (question), ?card= (explain a card), ?doc=&page= (about a book page).
	let context: ChatContext | null = null;
	const cardId = url.searchParams.get('card');
	const docId = url.searchParams.get('doc');
	if (cardId && cardsByIds([cardId]).length) {
		const c = reviewCard(cardId);
		if (c) context = { kind: 'card', cardId, label: `Card: ${notePreview(c.kind, c.fields, 80)}` };
	} else if (docId) {
		const d = getDocument(docId);
		const page = Number(url.searchParams.get('page')) || null;
		if (d) context = { kind: 'page', documentId: docId, page, label: `${d.title}${page ? ` · p. ${page}` : ''}` };
	}

	return {
		connected,
		provider: provider ? { id: provider, label: PROVIDER_LABELS[provider], model: modelFor(provider) } : null,
		threads: listThreads(),
		thread,
		context,
		question: url.searchParams.get('q') ?? (cardId ? 'Explain this card: why is the answer what it is?' : ''),
		/** ?mode=research opens a new conversation in Research mode. */
		mode: (thread?.mode ?? url.searchParams.get('mode')) === 'research' ? ('research' as const) : thread?.mode === 'explain' ? ('explain' as const) : ('guide' as const),
		canResearch: canResearch(provider),
		pending: pendingCount(),
		quizCount: quizQuestions({ limit: 1000 }).length
	};
};
