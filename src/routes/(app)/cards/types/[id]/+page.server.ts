import { error } from '@sveltejs/kit';
import { aiConnected } from '#lib/server/ai/providers.js';
import { mediaBase } from '#lib/server/anki/media.js';
import { getNoteTypeView } from '#lib/server/note-types.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, url }) => {
	const isNew = params.id === 'new';
	const type = isNew ? null : getNoteTypeView(params.id);
	if (!isNew && !type) error(404, 'Card type not found');
	return { type, isNew, ai: aiConnected(), startWithAi: url.searchParams.get('ai') === '1', mediaBase: mediaBase() };
};
