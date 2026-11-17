import { GenerateError, recordQuizAnswer } from '#lib/server/ai/generate.js';
import type { RequestHandler } from './$types';

/** Answer a quiz question: { questionId, choice, timeMs }. Recorded as an attempt (applied-practice evidence on the heatmap). */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { questionId?: string; choice?: number; timeMs?: number };
	try {
		return Response.json(recordQuizAnswer(String(body.questionId ?? ''), Number(body.choice), Number(body.timeMs) || 0));
	} catch (err) {
		if (err instanceof GenerateError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
};
