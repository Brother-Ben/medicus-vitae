import { listDocuments } from '#lib/server/library.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends }) => {
	depends('app:library');
	return { books: listDocuments() };
};
