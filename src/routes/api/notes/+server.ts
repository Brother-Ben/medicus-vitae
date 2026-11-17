import { renameDocument, LibraryError } from '#lib/server/library.js';
import { addLink, deleteNotesFile, NotesError, removeLink, updateLink, type LinkInput } from '#lib/server/notes.js';
import type { RequestHandler } from './$types';

/**
 * Notes PDFs: { action: 'link', link } adds a link to book pages, { action: 'update-link', id, link },
 * { action: 'unlink', id }, { action: 'rename', id, title }, { action: 'delete', id }.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { action?: string; id?: string; link?: LinkInput; title?: string };
	try {
		switch (body.action) {
			case 'link':
				if (!body.link) throw new NotesError('Missing link.');
				return Response.json({ id: addLink(body.link) }, { status: 201 });
			case 'update-link':
				if (!body.link || !body.id) throw new NotesError('Missing link.');
				updateLink(body.id, body.link);
				break;
			case 'unlink':
				removeLink(String(body.id ?? ''));
				break;
			case 'rename':
				renameDocument(String(body.id ?? ''), String(body.title ?? ''));
				break;
			case 'delete':
				deleteNotesFile(String(body.id ?? ''));
				break;
			default:
				return Response.json({ error: 'Unknown action.' }, { status: 400 });
		}
		return Response.json({ ok: true });
	} catch (err) {
		if (err instanceof NotesError || err instanceof LibraryError) return Response.json({ error: err.message }, { status: 400 });
		console.error(err);
		return Response.json({ error: 'Could not save.' }, { status: 500 });
	}
};
