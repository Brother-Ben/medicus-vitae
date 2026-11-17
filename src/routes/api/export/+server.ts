import { Readable } from 'node:stream';
import { buildExport, cardsCsv } from '#lib/server/exportimport.js';
import type { RequestHandler } from './$types';

/** Full export (zip, streamed) or ?cards=csv for the cards alone. */
export const GET: RequestHandler = async ({ url }) => {
	if (url.searchParams.get('cards') === 'csv') {
		return new Response(cardsCsv(), {
			headers: {
				'content-type': 'text/csv; charset=utf-8',
				'content-disposition': `attachment; filename="medicus-vitae-cards-${new Date().toISOString().slice(0, 10)}.csv"`,
				'cache-control': 'no-store'
			}
		});
	}
	const { stream, filename } = await buildExport();
	return new Response(Readable.toWeb(stream as Readable) as ReadableStream, {
		headers: {
			'content-type': 'application/zip',
			'content-disposition': `attachment; filename="${filename}"`,
			'cache-control': 'no-store'
		}
	});
};
