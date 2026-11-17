import { lastQualityReport, qualityProgress, startQualityCheck } from '#lib/server/ai/quality.js';
import { aiConnected } from '#lib/server/ai/providers.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = () => Response.json({ running: qualityProgress(), report: lastQualityReport() });

export const POST: RequestHandler = () => {
	if (!aiConnected()) return Response.json({ error: 'Connect an AI service first.' }, { status: 409 });
	if (!startQualityCheck()) return Response.json({ error: 'A quality check is already running.' }, { status: 409 });
	return Response.json({ started: true }, { status: 202 });
};
