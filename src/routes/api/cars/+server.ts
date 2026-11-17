import { AiError } from '#lib/server/ai/providers.js';
import { CarsError, deleteAttempt, deletePassage, recordAttempt, restorePassage, setAnswer, updateCarsPrefs, type AttemptInput, type CarsPrefs } from '#lib/server/cars.js';
import { importCapture, type Capture } from '#lib/server/cars-import.js';
import type { RequestHandler } from './$types';

const MAX_BODY = 8 * 1024 * 1024;

/**
 * { action: 'import', capture } (the bookmark), 'paste' { text, title?, url? },
 * 'prefs' { … }, 'attempt' { passageId, … }, 'answer' { questionId, answer },
 * 'delete' / 'restore' { passageId }, 'delete-attempt' { attemptId }.
 */
export const POST: RequestHandler = async ({ request }) => {
	const len = Number(request.headers.get('content-length') ?? 0);
	if (len > MAX_BODY) return Response.json({ error: 'That page is too big to import.' }, { status: 413 });
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		switch (body.action) {
			case 'import':
				return Response.json(await importCapture((body.capture ?? {}) as Capture));
			case 'paste': {
				const text = String(body.text ?? '');
				if (text.trim().length < 400) throw new CarsError('Paste the whole passage and its questions.');
				const source = body.source === 'aamc' ? 'aamc' : body.source === 'jackwestin' ? 'jackwestin' : 'other';
				return Response.json(await importCapture({ text, title: String(body.title ?? ''), url: String(body.url ?? '') }, { method: 'pasted', source }));
			}
			case 'prefs':
				return Response.json({ prefs: updateCarsPrefs((body.prefs ?? {}) as Partial<CarsPrefs>) });
			case 'attempt':
				return Response.json({ attempt: recordAttempt(String(body.passageId), body as unknown as AttemptInput) });
			case 'answer':
				setAnswer(String(body.questionId), body.answer === null || body.answer === undefined ? null : Number(body.answer));
				return Response.json({ ok: true });
			case 'delete':
				deletePassage(String(body.passageId));
				return Response.json({ ok: true });
			case 'restore':
				restorePassage(String(body.passageId));
				return Response.json({ ok: true });
			case 'delete-attempt':
				deleteAttempt(String(body.attemptId));
				return Response.json({ ok: true });
			default:
				return Response.json({ error: 'Unknown action.' }, { status: 400 });
		}
	} catch (err) {
		if (err instanceof CarsError) return Response.json({ error: err.message }, { status: 400 });
		if (err instanceof AiError) return Response.json({ error: err.message, code: err.code, manageUrl: err.manageUrl }, { status: 502 });
		console.error('CARS:', err);
		return Response.json({ error: 'Something went wrong with that passage.' }, { status: 500 });
	}
};
