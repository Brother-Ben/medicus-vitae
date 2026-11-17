import { eq } from 'drizzle-orm';
import { GenerateError, startGeneration, type GenKind } from '#lib/server/ai/generate.js';
import { aiConnected } from '#lib/server/ai/providers.js';
import { db } from '#lib/server/db/index.js';
import { generatedItem, job } from '#lib/server/db/schema.js';
import type { RequestHandler } from './$types';

/** Start generating from a book section: { documentId, sectionId, kind, count }. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { documentId?: string; sectionId?: string; kind?: string; count?: number };
	if (!aiConnected()) return Response.json({ error: 'Connect an AI service in Settings › AI first.', code: 'not_connected', manageUrl: '/settings/ai' }, { status: 409 });
	const kind = (['card', 'question', 'note'].includes(body.kind ?? '') ? body.kind : 'card') as GenKind;
	if (!body.documentId) return Response.json({ error: 'Choose a book section.' }, { status: 400 });
	try {
		return Response.json(startGeneration({ documentId: body.documentId, sectionId: body.sectionId ?? null, kind, count: Number(body.count) || 8 }), { status: 202 });
	} catch (err) {
		if (err instanceof GenerateError) return Response.json({ error: err.message }, { status: 400 });
		throw err;
	}
};

/** Progress of a generation job: ?job=&batch= */
export const GET: RequestHandler = ({ url }) => {
	const jobId = url.searchParams.get('job') ?? '';
	const batch = url.searchParams.get('batch') ?? '';
	const row = db().select().from(job).where(eq(job.id, jobId)).get();
	if (!row) return Response.json({ error: 'Not found.' }, { status: 404 });
	const items = batch ? db().select({ id: generatedItem.id, flagged: generatedItem.flagged }).from(generatedItem).where(eq(generatedItem.batchId, batch)).all() : [];
	return Response.json({ status: row.status, error: row.error, items: items.length, flagged: items.filter((i) => i.flagged).length });
};
