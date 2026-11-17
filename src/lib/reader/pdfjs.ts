// Loads PDF.js in the browser on first use (it is large, so only the reader and
// region previews pull it in).

type PdfJs = typeof import('pdfjs-dist');

let loading: Promise<PdfJs> | null = null;

export function loadPdfjs(): Promise<PdfJs> {
	loading ??= (async () => {
		const [pdfjs, worker] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
		pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
		return pdfjs;
	})();
	return loading;
}

export const PDF_OPTIONS = {
	standardFontDataUrl: '/pdfjs/standard_fonts/',
	cMapUrl: '/pdfjs/cmaps/',
	cMapPacked: true,
	wasmUrl: '/pdfjs/wasm/',
	isEvalSupported: false,
	disableAutoFetch: true,
	rangeChunkSize: 262144
};

const docs = new Map<string, Promise<import('pdfjs-dist').PDFDocumentProxy>>();

/** One open document per book, shared by the reader and region previews. */
export async function openBook(documentId: string) {
	let p = docs.get(documentId);
	if (!p) {
		p = loadPdfjs().then((pdfjs) => pdfjs.getDocument({ url: `/api/library/${documentId}/file`, ...PDF_OPTIONS }).promise);
		docs.set(documentId, p);
		p.catch(() => docs.delete(documentId));
	}
	return p;
}
