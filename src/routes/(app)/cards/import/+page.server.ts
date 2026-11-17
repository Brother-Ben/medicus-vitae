import { listImports } from '#lib/server/anki/importer.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => {
	return {
		imports: listImports(15).map((r) => ({
			id: r.id,
			fileName: r.fileName,
			status: r.status,
			createdAt: r.createdAt,
			finishedAt: r.finishedAt,
			notesAdded: (r.result as { notesAdded?: number } | null)?.notesAdded ?? null,
			notesUpdated: (r.result as { notesUpdated?: number } | null)?.notesUpdated ?? null
		}))
	};
};
