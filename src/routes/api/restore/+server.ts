import fs from 'node:fs';
import { RestoreError, restoreFromExport } from '#lib/server/exportimport.js';
import { receiveToTmp } from '#lib/server/files.js';
import { role } from '#lib/server/instance.js';
import type { RequestHandler } from './$types';

/** Replace this installation's data with a full export (the current data is kept aside first). */
export const PUT: RequestHandler = async ({ request }) => {
	if (role() !== 'primary') return Response.json({ error: 'Make this device primary before restoring.' }, { status: 409 });
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
