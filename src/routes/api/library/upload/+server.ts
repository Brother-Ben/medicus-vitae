import { receiveToTmp } from '#lib/server/files.js';
import { createDocumentFromUpload, LibraryError } from '#lib/server/library.js';
import type { RequestHandler } from './$types';

/** Streams a PDF to disk (no size cap, never fully in memory), then queues it for processing. */
export const PUT: RequestHandler = async ({ request, url }) => {
	if (!request.body) return Response.json({ error: 'No file received.' }, { status: 400 });
	const name = url.searchParams.get('name') || 'book.pdf';
	// role=notes: a PDF of your own notes (shown under Notes, linked to book pages).
	const role = url.searchParams.get('role') === 'notes' ? 'notes' : 'book';
	let received;
	try {
		received = await receiveToTmp(request.body);
	} catch {
		return Response.json({ error: 'The upload was interrupted.' }, { status: 400 });
	}
	try {
		const result = createDocumentFromUpload(received, name, role);
		return Response.json(result, { status: result.duplicate ? 200 : 201 });
	} catch (err) {
		const message = err instanceof LibraryError ? err.message : 'Could not import that file.';
		if (!(err instanceof LibraryError)) console.error(err);
		return Response.json({ error: message }, { status: 400 });
	}
};
