import {
	addMistakeLink,
	completeRepair,
	deleteMistake,
	logRetest,
	PracticeError,
	removeMistakeLink,
	reopenMistake,
	startRepair,
	updateMistake,
	type MistakeInput
} from '#lib/server/practice.js';
import { completeSessionWork } from '#lib/server/planner.js';
import type { RequestHandler } from './$types';

function fail(err: unknown) {
	if (err instanceof PracticeError) return Response.json({ error: err.message }, { status: 400 });
	console.error(err);
	return Response.json({ error: 'Could not save.' }, { status: 500 });
}

/** Edit the mistake's fields. */
export const PATCH: RequestHandler = async ({ params, request }) => {
	try {
		updateMistake(params.id, (await request.json()) as MistakeInput);
		return Response.json({ ok: true });
	} catch (err) {
		return fail(err);
	}
};

/** Repair flow: start-repair → complete-repair → retest (pass resolves, fail reopens). */
export const POST: RequestHandler = async ({ params, request }) => {
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		switch (body.action) {
			case 'start-repair':
				startRepair(params.id);
				break;
			case 'complete-repair':
				completeRepair(params.id, {
					explanation: String(body.explanation ?? ''),
					passageRevisited: !!body.passageRevisited,
					retestInDays: Number(body.retestInDays ?? 2)
				});
				// Finishes a "Fix" item for this mistake in today's session.
				completeSessionWork({ mistakeId: params.id });
				break;
			case 'retest':
				logRetest(params.id, {
					correct: !!body.correct,
					externalRef: String(body.externalRef ?? ''),
					note: String(body.note ?? ''),
					confidence: (body.confidence as string | null) ?? null
				});
				completeSessionWork({ mistakeId: params.id });
				break;
			case 'reopen':
				reopenMistake(params.id);
				break;
			case 'delete':
				deleteMistake(params.id);
				break;
			case 'link':
				addMistakeLink(params.id, body.kind === 'card' ? 'card' : 'anchor', String(body.refId ?? ''));
				break;
			case 'unlink':
				removeMistakeLink(String(body.linkId ?? ''));
				break;
			default:
				return Response.json({ error: 'Unknown action.' }, { status: 400 });
		}
		return Response.json({ ok: true });
	} catch (err) {
		return fail(err);
	}
};
