import fs from 'node:fs';
import { hasUser } from '#lib/server/auth.js';
import { RestoreError, restoreFromExport } from '#lib/server/exportimport.js';
import { receiveToTmp } from '#lib/server/files.js';
import type { RequestHandler } from './$types';

/** First run only: restore a full export into this fresh installation. */
export const PUT: RequestHandler = async ({ request }) => {
	if (hasUser()) return Response.json({ error: 'This installation is already set up.' }, { status: 409 });
	if (!request.body) return Response.json({ error: 'No file received.' }, { status: 400 });
	const received = await receiveToTmp(request.body);
	try {
		const result = await restoreFromExport(received.tmpPath);
		return Response.json({ ok: true, ...result });
	} catch (err) {
		const message = err instanceof RestoreError || err instanceof Error ? err.message : String(err);
		return Response.json({ error: message }, { status: 400 });
	} finally {
		fs.rmSync(received.tmpPath, { force: true });
	}
};
