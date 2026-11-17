import { AiError } from '#lib/server/ai/providers.js';
import { itemsFromWrongLists, mistakesFromItems, parseReport, saveImport, setItems, type FlImport, type SectionId } from '#lib/server/fl-import.js';
import { PracticeError } from '#lib/server/practice.js';
import type { RequestHandler } from './$types';

/**
 * Full-length question results:
 *  { action: 'parse', text }                       → what the copied report says (nothing saved)
 *  { action: 'save', exam: FlImport }               → a new full-length with its questions
 *  { action: 'save', exam, wrong, skipped }         → … from "the ones I got wrong" per section
 *  { action: 'set-items', id, items | wrong, skipped } → replace an existing exam's questions
 *  { action: 'mistakes', id, itemIds, reason }       → journal entries for wrong questions
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as {
		action?: string;
		text?: string;
		exam?: FlImport;
		id?: string;
		items?: FlImport['items'];
		wrong?: Partial<Record<SectionId, string>>;
		skipped?: Partial<Record<SectionId, string>>;
		itemIds?: string[];
		reason?: string;
	};
	try {
		switch (body.action) {
			case 'parse':
				return Response.json({ report: await parseReport(String(body.text ?? '')) });
			case 'save': {
				const exam = body.exam as FlImport;
				const items = body.wrong || body.skipped ? itemsFromWrongLists(body.wrong ?? {}, body.skipped ?? {}) : (exam?.items ?? []);
				return Response.json({ id: saveImport({ ...exam, items }) });
			}
			case 'set-items': {
				const items = body.wrong || body.skipped ? itemsFromWrongLists(body.wrong ?? {}, body.skipped ?? {}) : (body.items ?? []);
				setItems(String(body.id), items);
				return Response.json({ ok: true });
			}
			case 'mistakes':
				return Response.json({ made: mistakesFromItems(String(body.id), (body.itemIds ?? []).map(String), String(body.reason ?? 'content_gap')) });
			default:
				return Response.json({ error: 'Unknown action.' }, { status: 400 });
		}
	} catch (err) {
		if (err instanceof PracticeError) return Response.json({ error: err.message }, { status: 400 });
		if (err instanceof AiError) return Response.json({ error: err.message, code: err.code, manageUrl: err.manageUrl }, { status: 502 });
		console.error('Full-length import:', err);
		return Response.json({ error: 'Couldn’t read or save that full-length.' }, { status: 500 });
	}
};
