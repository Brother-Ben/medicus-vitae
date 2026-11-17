import { chapterSummary, InsightError, latestInsight, mistakePatterns, saveSummaryAsNote, studySuggestions, weeklyRecap, type InsightKind } from '#lib/server/ai/insights.js';
import { AiError } from '#lib/server/ai/providers.js';
import { GenerateError } from '#lib/server/ai/generate.js';
import type { RequestHandler } from './$types';

/** The last one of a kind: ?kind=recap|suggest|mistakes|chapter&scope=sectionId */
export const GET: RequestHandler = ({ url }) => {
	const kind = url.searchParams.get('kind') as InsightKind;
	if (!['recap', 'suggest', 'mistakes', 'chapter'].includes(kind)) return Response.json({ error: 'Unknown kind.' }, { status: 400 });
	return Response.json({ insight: latestInsight(kind, url.searchParams.get('scope') ?? '') });
};

/** Make a new one: { kind, sectionId? }, or keep a chapter summary as a note: { action: 'save-note', id }. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { kind?: string; sectionId?: string; action?: string; id?: string };
	try {
		if (body.action === 'save-note') return Response.json({ noteId: saveSummaryAsNote(String(body.id ?? '')) });
		switch (body.kind) {
			case 'recap':
				return Response.json({ insight: await weeklyRecap() });
			case 'suggest':
				return Response.json({ insight: await studySuggestions() });
			case 'mistakes':
				return Response.json({ insight: await mistakePatterns() });
			case 'chapter':
				if (!body.sectionId) return Response.json({ error: 'Pick a chapter.' }, { status: 400 });
				return Response.json({ insight: await chapterSummary(body.sectionId) });
			default:
				return Response.json({ error: 'Unknown kind.' }, { status: 400 });
		}
	} catch (err) {
		if (err instanceof AiError) return Response.json({ error: err.message, code: err.code, manageUrl: err.manageUrl }, { status: err.code === 'not_connected' ? 409 : 502 });
		if (err instanceof InsightError || err instanceof GenerateError) return Response.json({ error: err.message }, { status: 400 });
		console.error(err);
		return Response.json({ error: 'The AI request didn’t work. Try again in a moment.' }, { status: 500 });
	}
};
