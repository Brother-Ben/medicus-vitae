import fs from 'node:fs';
import { Worker } from 'node:worker_threads';
import { and, eq } from 'drizzle-orm';
import { config } from './config';
import { db, sqlite } from './db';
import { docPage, docSection, document, documentVersion } from './db/schema';
import { commitTmpFile, storedFileExists, storedFilePath } from './files';
import { uuidv7 } from './ids';
import { requestIndex } from './ai/indexer';
import { registerJobHandler, type JobContext } from './jobs';
import { indexEntry, unindexDocumentPages } from './search';
import { suggestCategories } from './tagging';

// Book processing pipeline (spec 9.5): store original → extract text with
// positions in a worker thread → keyword index → chapters + AAMC suggestions →
// ready. Each run starts from a clean slate for its version, so a run that was
// interrupted is simply redone.

interface PageMsg {
	type: 'page';
	page: number;
	width: number;
	height: number;
	text: string;
	runs: number[][];
}

type WorkerMsg =
	| { type: 'meta'; numPages: number; title: string; extractor: string }
	| { type: 'outline'; items: { title: string; level: number; page: number }[] }
	| PageMsg
	| { type: 'done'; numPages: number; textChars: number }
	| { type: 'error'; message: string };

const BATCH = 20;
const STALL_MS = 180_000;

function cleanTitle(t: string) {
	return t.replace(/^Microsoft Word\s*-\s*/i, '').replace(/\.(pdf|docx?)$/i, '').trim();
}

export function defaultTitleFromFileName(fileName: string) {
	return fileName.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ').trim() || 'Untitled book';
}

function writePages(versionId: string, docId: string, pages: PageMsg[]) {
	const conn = sqlite();
	const insertPage = conn.prepare(
		'INSERT INTO doc_page (id, version_id, page_number, width, height, text, items, provenance) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
	);
	conn.transaction(() => {
		for (const p of pages) {
			const id = uuidv7();
			insertPage.run(id, versionId, p.page, p.width, p.height, p.text, JSON.stringify(p.runs), 'original');
			indexEntry(conn, { kind: 'page', refId: id, body: p.text, docId, page: p.page });
		}
	})();
}

function buildSections(
	docId: string,
	versionId: string,
	title: string,
	numPages: number,
	outline: { title: string; level: number; page: number }[]
) {
	const items = outline
		.filter((o) => o.page >= 1 && o.page <= numPages && o.level <= 1)
		.map((o, i) => ({ ...o, i }));
	const sections: { title: string; level: number; pageStart: number; pageEnd: number }[] = [];
	if (!items.length) {
		sections.push({ title, level: 0, pageStart: 1, pageEnd: Math.max(1, numPages) });
	} else {
		for (let k = 0; k < items.length; k++) {
			const it = items[k];
			// A section runs until the next item at the same or a higher level.
			let end = numPages;
			for (let j = k + 1; j < items.length; j++) {
				if (items[j].level <= it.level) {
					end = Math.max(it.page, items[j].page - 1);
					break;
				}
			}
			sections.push({ title: it.title, level: it.level, pageStart: it.page, pageEnd: end });
		}
	}

	const textFor = sqlite().prepare(
		`SELECT group_concat(text, ' ') AS body FROM doc_page
		 WHERE version_id = ? AND page_number BETWEEN ? AND ?`
	);
	db().transaction((tx) => {
		tx.delete(docSection).where(eq(docSection.documentId, docId)).run();
		sections.forEach((s, position) => {
			const body = (textFor.get(versionId, s.pageStart, s.pageEnd) as { body: string | null }).body ?? '';
			tx.insert(docSection)
				.values({
					id: uuidv7(),
					documentId: docId,
					title: s.title,
					level: s.level,
					position,
					pageStart: s.pageStart,
					pageEnd: s.pageEnd,
					aamcCodes: [],
					suggestedCodes: suggestCategories(s.title, body),
					confirmed: false
				})
				.run();
		});
	});
}

function runWorker(filePath: string, onMessage: (msg: WorkerMsg) => void, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(config.paths.pdfWorker, {
			workerData: { filePath },
			resourceLimits: { maxOldGenerationSizeMb: 1536 }
		});
		let finished = false;
		let stall: NodeJS.Timeout;
		const finish = (err?: Error) => {
			if (finished) return;
			finished = true;
			clearTimeout(stall);
			signal.removeEventListener('abort', onAbort);
			void worker.terminate();
			if (err) reject(err);
			else resolve();
		};
		const arm = () => {
			clearTimeout(stall);
			stall = setTimeout(() => finish(new Error('Processing stopped responding. Try importing the book again.')), STALL_MS);
		};
		const onAbort = () => finish(new Error('Stopped'));
		signal.addEventListener('abort', onAbort);
		arm();
		worker.on('message', (msg: WorkerMsg) => {
			arm();
			try {
				onMessage(msg);
			} catch (err) {
				finish(err instanceof Error ? err : new Error(String(err)));
				return;
			}
			if (msg.type === 'done') finish();
			if (msg.type === 'error') finish(new Error(msg.message));
		});
		worker.on('error', (err) =>
			finish(
				(err as NodeJS.ErrnoException).code === 'ERR_WORKER_OUT_OF_MEMORY'
					? new Error('This PDF needed more memory than allowed while processing.')
					: err
			)
		);
		worker.on('exit', (code) => {
			if (!finished) finish(new Error(`Processing ended unexpectedly (code ${code}).`));
		});
	});
}

async function extractPdf(payload: { documentId: string; versionId: string; tmpPath?: string }, ctx: JobContext) {
	const doc = db().select().from(document).where(eq(document.id, payload.documentId)).get();
	if (!doc) return;
	if (payload.tmpPath && fs.existsSync(payload.tmpPath)) commitTmpFile(payload.tmpPath, doc.fileHash);
	if (!storedFileExists(doc.fileHash)) {
		throw new Error('The uploaded file is missing (the upload may have been interrupted). Import it again.');
	}

	// Start clean: remove anything a previous, interrupted run wrote for this version.
	const conn = sqlite();
	conn.transaction(() => {
		conn.prepare('DELETE FROM doc_page WHERE version_id = ?').run(payload.versionId);
		unindexDocumentPages(conn, doc.id);
	})();
	db()
		.update(document)
		.set({ status: 'processing', error: null, notice: null, updatedAt: Date.now() })
		.where(eq(document.id, doc.id))
		.run();

	let numPages = 0;
	let metaTitle = '';
	let extractor = '';
	let outline: { title: string; level: number; page: number }[] = [];
	let textChars = 0;
	let batch: PageMsg[] = [];
	let written = 0;

	const flush = () => {
		if (!batch.length) return;
		writePages(payload.versionId, doc.id, batch);
		written += batch.length;
		batch = [];
		ctx.progress(numPages ? written / numPages : 0, `Indexed ${written} of ${numPages} pages`);
	};

	await runWorker(
		storedFilePath(doc.fileHash),
		(msg) => {
			if (msg.type === 'meta') {
				numPages = msg.numPages;
				metaTitle = cleanTitle(msg.title);
				extractor = msg.extractor;
				ctx.progress(0, `Reading ${numPages} pages`);
			} else if (msg.type === 'outline') {
				outline = msg.items;
			} else if (msg.type === 'page') {
				batch.push(msg);
				if (batch.length >= BATCH) flush();
			} else if (msg.type === 'done') {
				flush();
				textChars = msg.textChars;
			}
		},
		ctx.signal
	);

	const now = Date.now();
	const fallbackTitle = defaultTitleFromFileName(doc.fileName);
	const title =
		doc.title === fallbackTitle && metaTitle.length >= 3 && metaTitle.length <= 150 ? metaTitle : doc.title;

	ctx.progress(0.98, 'Finding chapters');
	buildSections(doc.id, payload.versionId, title, numPages, outline);

	const notice =
		textChars < 20 * Math.max(1, numPages) && textChars < 2000
			? 'No selectable text was found, so this looks like a scanned PDF. You can read it and mark page regions; search and text highlights need OCR, which comes in a later version.'
			: null;

	db().transaction((tx) => {
		tx.update(documentVersion)
			.set({ status: 'ready', pageCount: numPages, completedAt: now, extractionVersion: extractor || 'pdfjs' })
			.where(eq(documentVersion.id, payload.versionId))
			.run();
		tx.update(document)
			.set({
				status: 'ready',
				title,
				pageCount: numPages,
				currentVersionId: payload.versionId,
				notice,
				error: null,
				updatedAt: now
			})
			.where(eq(document.id, doc.id))
			.run();
	});
}

registerJobHandler('extract_pdf', async (row, ctx) => {
	const payload = row.payload as { documentId: string; versionId: string; tmpPath?: string };
	try {
		await extractPdf(payload, ctx);
		// New pages for the tutor's search index.
		requestIndex();
	} catch (err) {
		if (ctx.signal.aborted) throw err;
		const message = err instanceof Error ? err.message : String(err);
		db()
			.update(document)
			.set({ status: 'failed', error: message, updatedAt: Date.now() })
			.where(and(eq(document.id, payload.documentId)))
			.run();
		db()
			.update(documentVersion)
			.set({ status: 'failed' })
			.where(eq(documentVersion.id, payload.versionId))
			.run();
		throw err;
	}
});

export function pagesForVersion(versionId: string) {
	return db()
		.select({ pageNumber: docPage.pageNumber, width: docPage.width, height: docPage.height })
		.from(docPage)
		.where(eq(docPage.versionId, versionId))
		.orderBy(docPage.pageNumber)
		.all();
}
