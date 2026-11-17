import { error } from '@sveltejs/kit';
import { getImport } from '#lib/server/anki/importer.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params }) => {
	const row = getImport(params.id);
	if (!row) error(404, 'That import doesn’t exist.');
	return { imp: row };
};
