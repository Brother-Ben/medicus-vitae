import fs from 'node:fs';
import { importWorkDir, packagePath, startImport } from '#lib/server/anki/importer.js';
import { isZipHeader } from '#lib/server/anki/package.js';
import { receiveToTmp } from '#lib/server/files.js';
import { uuidv7 } from '#lib/server/ids.js';
import type { RequestHandler } from './$types';

/** Streams an Anki package (.apkg / .colpkg) to disk, then starts reading it. Nothing is imported until confirmed. */
export const PUT: RequestHandler = async ({ request, url }) => {
	if (!request.body) return Response.json({ error: 'No file received.' }, { status: 400 });
	const name = (url.searchParams.get('name') || 'deck.apkg').slice(0, 200);
	let received;
	try {
		received = await receiveToTmp(request.body);
	} catch {
		return Response.json({ error: 'The upload was interrupted.' }, { status: 400 });
	}
	if (!isZipHeader(received.head)) {
		fs.rmSync(received.tmpPath, { force: true });
		return Response.json(
			{ error: 'That isn’t an Anki package. In Anki, use File › Export, choose “Anki Deck Package (.apkg)”, and import that file.' },
			{ status: 400 }
		);
	}
	const id = uuidv7();
	fs.mkdirSync(importWorkDir(id), { recursive: true });
	fs.renameSync(received.tmpPath, packagePath(id));
	startImport({ id, fileName: name, fileSize: received.size, fileHash: received.hash });
	return Response.json({ id }, { status: 201 });
};
