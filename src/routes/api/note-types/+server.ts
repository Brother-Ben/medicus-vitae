import { AiError } from '#lib/server/ai/providers.js';
import {
	aiDesignNoteType,
	createNoteType,
	deleteNoteType,
	duplicateNoteType,
	ensureImageOcclusionType,
	getNoteTypeView,
	listNoteTypes,
	NoteTypeError,
	previewCard,
	updateNoteType,
	type NoteTypeInput
} from '#lib/server/note-types.js';
import { mediaBase } from '#lib/server/anki/media.js';
import type { RequestHandler } from './$types';

/** Card types: the list, or one with ?id=. */
export const GET: RequestHandler = ({ url }) => {
	const id = url.searchParams.get('id');
	if (id) {
		const t = getNoteTypeView(id);
		return t ? Response.json({ type: t }) : Response.json({ error: 'Card type not found.' }, { status: 404 });
	}
	ensureImageOcclusionType();
	return Response.json({ types: listNoteTypes() });
};

/**
 * { action: 'create' | 'update' (id) | 'duplicate' (id, name?) | 'delete' (id) |
 *   'preview' (type, sample, ord) | 'ai' (description, current?) }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		action?: string;
		id?: string;
		name?: string;
		type?: NoteTypeInput;
		sample?: Record<string, string>;
		ord?: number;
		description?: string;
		current?: Partial<NoteTypeInput> | null;
	};
	try {
		switch (body.action) {
			case 'create':
				return Response.json({ id: createNoteType(body.type as NoteTypeInput) });
			case 'update':
				updateNoteType(String(body.id), body.type as NoteTypeInput);
				return Response.json({ ok: true });
			case 'duplicate':
				return Response.json({ id: duplicateNoteType(String(body.id), body.name) });
			case 'delete':
				deleteNoteType(String(body.id));
				return Response.json({ ok: true });
			case 'preview': {
				const t = body.type as NoteTypeInput;
				return Response.json({ ...previewCard({ name: t?.name ?? '', kind: t?.kind === 'cloze' ? 'cloze' : 'standard', fields: t?.fields ?? [], templates: t?.templates ?? [] }, body.sample ?? {}, Number(body.ord) || 0), mediaBase: mediaBase() });
			}
			case 'ai':
				return Response.json({ design: await aiDesignNoteType(String(body.description ?? ''), body.current ?? null) });
			default:
				return Response.json({ error: 'Unknown action.' }, { status: 400 });
		}
	} catch (err) {
		if (err instanceof NoteTypeError) return Response.json({ error: err.message }, { status: 400 });
		if (err instanceof AiError) return Response.json({ error: err.message, code: err.code, manageUrl: err.manageUrl }, { status: 502 });
		console.error('Card types:', err);
		return Response.json({ error: 'Couldn’t save the card type.' }, { status: 500 });
	}
};
