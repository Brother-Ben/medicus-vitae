import {
	CardError,
	clearLeech,
	createNote,
	createNoteFromSelection,
	createTemplatedNote,
	createTemplatedNoteFromSelection,
	noteForEdit,
	setSuspended,
	updateNote,
	type NoteInput,
	type TemplatedNoteInput
} from '#lib/server/cards.js';
import { ensureImageOcclusionType, IO_TYPE_ID } from '#lib/server/note-types.js';
import { deleteCardNote, DeleteError, restoreDeleted, type DeletedCards } from '#lib/server/deletion.js';
import { ReadingError, type AnchorInput } from '#lib/server/reading.js';
import { undoSuspendBatch } from '#lib/server/suspend.js';
import type { RequestHandler } from './$types';

function err(e: unknown) {
	if (e instanceof CardError || e instanceof ReadingError || e instanceof DeleteError) return Response.json({ error: e.message }, { status: 400 });
	console.error(e);
	return Response.json({ error: 'Could not save the card.' }, { status: 500 });
}

/** A note for editing: ?noteId= */
export const GET: RequestHandler = ({ url }) => {
	const note = noteForEdit(url.searchParams.get('noteId') ?? '');
	if (!note) return Response.json({ error: 'Card not found.' }, { status: 404 });
	return Response.json({ note });
};

/**
 * Create: { note, anchor? | anchorId? }, or { templated: { noteTypeId, fields, tags, aamcCode }, anchor? | anchorId? }
 * for a card type with its own templates (made here, from Anki, or image occlusion).
 * With an anchor, the passage link is saved with the card or not at all.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { note?: NoteInput; templated?: TemplatedNoteInput; anchor?: AnchorInput; anchorId?: string };
	if (!body.note && !body.templated) return Response.json({ error: 'Missing card.' }, { status: 400 });
	try {
		if (body.templated) {
			if (body.templated.noteTypeId === IO_TYPE_ID) ensureImageOcclusionType();
			const input = { ...body.templated, anchorId: body.anchorId ?? null };
			const result = body.anchor ? createTemplatedNoteFromSelection(body.anchor, input) : createTemplatedNote(input);
			return Response.json(result, { status: 201 });
		}
		const note = body.note!;
		const result = body.anchor ? createNoteFromSelection(body.anchor, note) : createNote({ ...note, anchorId: body.anchorId ?? null });
		return Response.json(result, { status: 201 });
	} catch (e) {
		return err(e);
	}
};

/**
 * Edit { noteId, note }; delete { noteId, delete: true, alsoInAnki? } (returns what
 * to send back to undo it); undo a delete { restore: {...} }; suspend { cardId |
 * cardIds, suspended }; undo a suspend batch { undoBatch }; clear a leech flag
 * { cardId, leech: false }.
 */
export const PATCH: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		noteId?: string;
		note?: NoteInput;
		delete?: boolean;
		alsoInAnki?: boolean;
		restore?: DeletedCards;
		cardId?: string;
		cardIds?: string[];
		suspended?: boolean;
		undoBatch?: string;
		leech?: boolean;
	};
	try {
		if (body.cardId && body.leech === false) clearLeech(body.cardId);
		else if ((body.cardId || body.cardIds?.length) && body.suspended !== undefined) {
			const r = setSuspended(body.cardIds?.length ? body.cardIds.map(String).slice(0, 50_000) : String(body.cardId), !!body.suspended);
			return Response.json({ ok: true, ...r });
		} else if (body.undoBatch) return Response.json({ ok: true, ...undoSuspendBatch(String(body.undoBatch)) });
		else if (body.noteId && body.delete) return Response.json({ ok: true, ...(await deleteCardNote(body.noteId, { alsoInAnki: !!body.alsoInAnki })) });
		else if (body.restore) return Response.json({ ok: true, ...restoreDeleted(body.restore) });
		else if (body.noteId && body.note) updateNote(body.noteId, body.note);
		else return Response.json({ error: 'Nothing to change.' }, { status: 400 });
		return Response.json({ ok: true });
	} catch (e) {
		return err(e);
	}
};
