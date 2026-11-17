import { AnkiImportError, cancelImport, confirmImport, getImport, type ImportDecisions } from '#lib/server/anki/importer.js';
import type { RequestHandler } from './$types';

/** Status, progress and (when ready) the report of one import. */
export const GET: RequestHandler = ({ params }) => {
	const row = getImport(params.id);
	if (!row) return Response.json({ error: 'Import not found.' }, { status: 404 });
	return Response.json({ import: row });
};

/** { action: 'confirm', decisions } starts the import; { action: 'cancel' } drops it. */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as { action?: string; decisions?: Partial<ImportDecisions> };
	try {
		if (body.action === 'confirm') {
			const d = body.decisions ?? {};
			const conflicts: Record<string, 'keep' | 'overwrite'> = {};
			for (const [guid, choice] of Object.entries(d.conflicts ?? {})) {
				if (choice === 'keep' || choice === 'overwrite') conflicts[guid] = choice;
			}
			confirmImport(params.id, {
				conflicts,
				conflictDefault: d.conflictDefault === 'overwrite' ? 'overwrite' : 'keep',
				useDeckRetention: !!d.useDeckRetention
			});
			return Response.json({ ok: true });
		}
		if (body.action === 'cancel') {
			cancelImport(params.id);
			return Response.json({ ok: true });
		}
		return Response.json({ error: 'Unknown action.' }, { status: 400 });
	} catch (err) {
		if (err instanceof AnkiImportError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
};
