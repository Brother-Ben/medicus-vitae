import { createMistake, PracticeError, type MistakeInput } from '#lib/server/practice.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as MistakeInput;
	try {
		return Response.json({ id: createMistake(body) }, { status: 201 });
	} catch (err) {
		if (err instanceof PracticeError) return Response.json({ error: err.message }, { status: 400 });
		console.error(err);
		return Response.json({ error: 'Could not save the mistake.' }, { status: 500 });
	}
};
