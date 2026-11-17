<script lang="ts">
	import { onMount, tick } from 'svelte';
	import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist';
	import AnnotationEditor from '#lib/components/AnnotationEditor.svelte';
	import CardEditor, { type CardContext, type CardDraft } from '#lib/components/CardEditor.svelte';
	import Icon from '#lib/components/Icon.svelte';
	import TutorChat, { type ChatMessageView } from '#lib/components/TutorChat.svelte';
	import { trackActivity } from '#lib/client/activity.js';
	import { api } from '#lib/client/api.js';
	import { appearance, setAccountAppearance } from '#lib/client/appearance.svelte.js';
	import { PAGE_STYLES } from '#lib/appearance.js';
	import { toast, toastError } from '#lib/client/toast.svelte.js';
	import { kindForNoteType, notePreview } from '#lib/cards.js';
	import { renderMarkdown } from '#lib/markdown.js';
	import { buildPageText, rectsForRange } from '#lib/pdf/pagetext.js';
	import { anchorFromSelection, matchRanges, textInRegion, type AnchorInputClient, type PageText } from '#lib/reader/anchors.js';
	import { loadPdfjs, openBook } from '#lib/reader/pdfjs.js';
	import { markSections } from '#lib/client/progress.js';
	import { isCovered, leafSections, mergeRanges, type PageRange } from '#lib/ranges.js';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	type Highlight = (typeof data.marks.highlights)[number];
	type Annotation = (typeof data.marks.annotations)[number];

	const COLORS = [
		{ name: 'yellow', label: 'Yellow' },
		{ name: 'teal', label: 'Teal' },
		{ name: 'pink', label: 'Pink' },
		{ name: 'blue', label: 'Blue' }
	];
	const ZOOMS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

	const doc = $derived(data.doc);
	// Server data first (correct on first paint); replaced after each change.
	let highlights = $derived<Highlight[]>(data.marks.highlights);
	let annotations = $derived<Annotation[]>(data.marks.annotations);
	let cardAnchors = $derived(data.cardAnchors);

	let scrollEl: HTMLDivElement | undefined = $state();
	let pagesEl: HTMLDivElement | undefined = $state();
	let scale = $state(1);
	let zoomMode = $state<'fit' | 'manual'>('fit');
	let currentPage = $state(1);
	let pageInput = $state('1');
	let color = $state('yellow');
	let regionMode = $state(false);
	let panel = $state<'notes' | 'contents' | 'search' | 'tutor' | null>(null);
	// The tutor conversation beside the book: a fresh one per selection asked about.
	let tutorKey = $state(0);
	let tutorThread = $state<string | null>(null);
	let tutorMessages = $state<ChatMessageView[]>([]);
	let tutorAnchor = $state<AnchorInputClient | null>(null);
	let tutorQuestion = $state('');
	let loadError = $state('');
	let loading = $state(true);
	let renderedTick = $state(0);
	let flash = $state<{ page: number; rects: number[][] } | null>(null);
	let draftRegion = $state<{ page: number; rect: number[] } | null>(null);

	let selMenu = $state<{ x: number; y: number; anchor: AnchorInputClient } | null>(null);
	let hlMenu = $state<{ x: number; y: number; h: Highlight } | null>(null);

	let cardOpen = $state(false);
	let cardDraft = $state<CardDraft>({ kind: 'basic', fields: {}, aamcCode: null, tags: [] });
	let cardContext = $state<CardContext | null>(null);
	let cardAnchor = $state<AnchorInputClient | null>(null);
	let cardAnchorId = $state<string | null>(null);

	let noteOpen = $state(false);
	let noteState = $state<{
		annotationId: string | null;
		body: string;
		quote: string;
		anchor: AnchorInputClient | null;
		anchorId: string | null;
		documentId: string | null;
	}>({ annotationId: null, body: '', quote: '', anchor: null, anchorId: null, documentId: null });

	let searchQ = $state('');
	let activeQuery = $state('');
	let searchResults = $state<{ page: number; segments: { text: string; hit: boolean }[] }[]>([]);
	let searching = $state(false);

	interface PageRender {
		el?: HTMLDivElement;
		canvasHost?: HTMLDivElement;
		layer?: HTMLDivElement;
		renderedScale?: number;
		task?: RenderTask | null;
		text?: PageText;
		textContent?: unknown;
		busy?: boolean;
	}
	const pageState = new Map<number, PageRender>();
	const near = new Set<number>();
	const ratios = new Map<number, number>();
	let pdf: PDFDocumentProxy | null = null;
	let running = 0;

	const maxWidth = $derived(Math.max(1, ...data.pages.map((p) => p.width)));

	function st(n: number) {
		let s = pageState.get(n);
		if (!s) {
			s = {};
			pageState.set(n, s);
		}
		return s;
	}

	function group<T extends { page: number | null }>(list: T[]) {
		const m = new Map<number, T[]>();
		for (const x of list) {
			if (x.page == null) continue;
			const arr = m.get(x.page) ?? [];
			arr.push(x);
			m.set(x.page, arr);
		}
		return m;
	}
	const hlByPage = $derived(group(highlights));
	const notesByPage = $derived(group(annotations.filter((a) => a.page !== null)));
	const cardsByPage = $derived(group(cardAnchors));
	const bookNotes = $derived(annotations.filter((a) => a.page === null));
	const sortedNotes = $derived([...annotations.filter((a) => a.page !== null)].sort((a, b) => (a.page ?? 0) - (b.page ?? 0)));

	function sectionFor(page: number) {
		return data.sections
			.filter((s) => s.pageStart <= page && s.pageEnd >= page)
			.sort((a, b) => b.level - a.level)[0];
	}

	function defaultCode(page: number) {
		for (const s of data.sections.filter((x) => x.pageStart <= page && x.pageEnd >= page).sort((a, b) => b.level - a.level)) {
			if (s.aamcCodes.length) return s.aamcCodes[0];
		}
		return null;
	}

	const currentSection = $derived(sectionFor(currentPage));

	// Progress is what's marked done (chapters), never pages merely opened.
	let readRanges = $state<PageRange[]>([]);
	$effect(() => {
		readRanges = data.doc.readRanges as PageRange[];
	});
	const ranges = $derived(mergeRanges(readRanges, doc.pageCount));
	const leaves = $derived(leafSections(data.sections));
	const sectionDone = (s: { pageStart: number; pageEnd: number }) => isCovered(ranges, s.pageStart, s.pageEnd);
	const doneCount = $derived(leaves.filter((s) => sectionDone(s)).length);
	/** The innermost section on this page that progress counts in. */
	const currentLeaf = $derived(leaves.filter((s) => s.pageStart <= currentPage && s.pageEnd >= currentPage).sort((a, b) => b.pageStart - a.pageStart)[0] ?? null);
	let promptDismissed = $state<Record<string, boolean>>({});
	const endPrompt = $derived(
		currentLeaf && currentPage === currentLeaf.pageEnd && !sectionDone(currentLeaf) && !promptDismissed[currentLeaf.id] && doc.status === 'ready' ? currentLeaf : null
	);

	async function reloadRanges() {
		try {
			const r = await api<{ readRanges: PageRange[] }>(`/api/library/${doc.id}`);
			readRanges = r.readRanges;
		} catch {
			// keep what we have
		}
	}

	async function setDone(s: { id: string; title: string }, done: boolean) {
		const r = await markSections(doc.id, [s.id], done, s.title, reloadRanges);
		if (r) readRanges = r.ranges;
	}

	/** Notes PDFs linked to the page you're on (or, reading a notes PDF, the book pages it covers). */
	const pageNotes = $derived.by(() => {
		if (data.role === 'notes') {
			return data.linkedBooks
				.filter((l) => l.notesPageFrom === null || (currentPage >= l.notesPageFrom && currentPage <= (l.notesPageTo ?? l.notesPageFrom)))
				.map((l) => ({ id: l.id, href: `/library/${l.bookDocumentId}/read?page=${l.bookPageFrom}`, text: `${l.bookTitle} · p. ${l.bookPageFrom}${l.bookPageTo !== l.bookPageFrom ? `–${l.bookPageTo}` : ''}` }));
		}
		return data.linkedNotes
			.filter((l) => currentPage >= l.bookPageFrom && currentPage <= l.bookPageTo)
			.map((l) => ({ id: l.id, href: `/library/${l.notesDocumentId}/read?page=${l.notesPageFrom ?? 1}`, text: `${l.label || l.notesTitle}${l.notesPageFrom ? ` · p. ${l.notesPageFrom}` : ''}` }));
	});

	// ------------------------------------------------------------- render

	function schedule() {
		const want = [...near].sort((a, b) => Math.abs(a - currentPage) - Math.abs(b - currentPage));
		for (const n of want) {
			if (running >= 2) break;
			const s = st(n);
			if (s.busy || s.renderedScale === scale) continue;
			running++;
			s.busy = true;
			renderPage(n)
				.catch((err) => console.warn(`Page ${n} failed to render`, err))
				.finally(() => {
					s.busy = false;
					running--;
					schedule();
				});
		}
	}

	async function renderPage(n: number) {
		const s = st(n);
		if (!pdf || !s.el || !s.canvasHost || !s.layer) return;
		const target = scale;
		const page = await pdf.getPage(n);
		const viewport = page.getViewport({ scale: target });
		const dpr = Math.min(2.5, window.devicePixelRatio || 1);
		const canvas = document.createElement('canvas');
		canvas.width = Math.floor(viewport.width * dpr);
		canvas.height = Math.floor(viewport.height * dpr);
		canvas.className = 'page-canvas';
		s.task?.cancel();
		const task = page.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined });
		s.task = task;
		try {
			await task.promise;
		} catch (err) {
			if ((err as Error)?.name === 'RenderingCancelledException') return;
			throw err;
		}
		if (target !== scale || !near.has(n)) return;
		s.canvasHost.replaceChildren(canvas);

		const pdfjs = await loadPdfjs();
		const content = (s.textContent ??= await page.getTextContent()) as Awaited<ReturnType<typeof page.getTextContent>>;
		const base = page.getViewport({ scale: 1 });
		const built = buildPageText(content.items as never, base, content.styles as never);
		s.layer.replaceChildren();
		const layer = new pdfjs.TextLayer({ textContentSource: content, container: s.layer, viewport });
		await layer.render();
		const divs = layer.textDivs;
		const aligned = divs.length === built.runs.length;
		s.text = {
			text: built.text,
			runs: built.runs,
			divs: aligned ? divs : [],
			divIndex: aligned ? new Map(divs.map((d, i) => [d as Element, i])) : new Map()
		};
		s.renderedScale = target;
		renderedTick++;
	}

	function unrender(n: number) {
		const s = pageState.get(n);
		if (!s) return;
		s.task?.cancel();
		s.canvasHost?.replaceChildren();
		s.layer?.replaceChildren();
		if (s.text) s.text = { ...s.text, divs: [], divIndex: new Map() };
		s.renderedScale = undefined;
	}

	function fitScale() {
		if (!scrollEl) return 1;
		const w = scrollEl.clientWidth - (window.innerWidth < 700 ? 16 : 56);
		return Math.max(0.4, Math.min(3, w / maxWidth));
	}

	async function setScale(next: number, mode: 'fit' | 'manual' = 'manual') {
		if (!scrollEl) return;
		zoomMode = mode;
		const s = pageState.get(currentPage);
		const frac = s?.el ? (scrollEl.scrollTop - s.el.offsetTop) / Math.max(1, s.el.offsetHeight) : 0;
		const anchorPage = currentPage;
		scale = Math.round(next * 1000) / 1000;
		await tick();
		const after = pageState.get(anchorPage);
		if (after?.el) scrollEl.scrollTop = after.el.offsetTop + frac * after.el.offsetHeight;
		schedule();
	}

	function zoom(dir: 1 | -1) {
		const i = ZOOMS.findIndex((z) => z >= scale - 0.001);
		const idx = dir > 0 ? (ZOOMS[i] > scale + 0.001 ? i : i + 1) : i - 1;
		void setScale(ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, idx))]);
	}

	// ------------------------------------------------------- navigation

	async function jumpTo(page: number, rects?: number[][] | null, doFlash = true) {
		const s = pageState.get(page);
		if (!s?.el || !scrollEl) return;
		const offset = rects?.length ? Math.max(0, rects[0][1] * s.el.offsetHeight - 120) : -12;
		scrollEl.scrollTo({ top: s.el.offsetTop + offset });
		if (rects?.length && doFlash) {
			flash = { page, rects };
			setTimeout(() => {
				if (flash?.page === page) flash = null;
			}, 2600);
		}
		if (window.innerWidth < 900) panel = null;
	}

	let saveTimer: ReturnType<typeof setTimeout> | null = null;
	$effect(() => {
		const p = currentPage;
		pageInput = String(p);
		if (saveTimer) clearTimeout(saveTimer);
		saveTimer = setTimeout(() => {
			void api(`/api/library/${doc.id}`, { body: { action: 'position', page: p } }).catch(() => {});
		}, 1500);
	});

	// --------------------------------------------------------- selection

	function pageFromNode(node: Node | null): number | null {
		let el = node instanceof Element ? node : node?.parentElement;
		while (el && !(el as HTMLElement).dataset?.page) el = el.parentElement;
		return el ? Number((el as HTMLElement).dataset.page) : null;
	}

	function menuPos(rect: DOMRect) {
		const box = pagesEl!.getBoundingClientRect();
		return { x: rect.left + rect.width / 2 - box.left, y: rect.top - box.top };
	}

	function checkSelection() {
		if (regionMode || !pagesEl) return;
		const sel = window.getSelection();
		if (!sel || sel.isCollapsed || !sel.rangeCount) return;
		const n = pageFromNode(sel.anchorNode);
		if (!n) return;
		const s = pageState.get(n);
		if (!s?.el || !s.layer || !s.text) return;
		const anchor = anchorFromSelection(sel, s.el, s.layer, s.text, { documentId: doc.id, versionId: doc.versionId ?? '', page: n });
		if (!anchor) return;
		const rect = sel.getRangeAt(0).getBoundingClientRect();
		hlMenu = null;
		selMenu = { ...menuPos(rect), anchor };
	}

	function onPagesPointerUp(e: PointerEvent) {
		if (regionMode) return;
		setTimeout(() => {
			const sel = window.getSelection();
			if (sel && !sel.isCollapsed) {
				checkSelection();
				return;
			}
			// A click with no selection: did it land on a highlight?
			const n = pageFromNode(e.target as Node);
			const s = n ? pageState.get(n) : null;
			if (!n || !s?.el) return;
			const box = s.el.getBoundingClientRect();
			const x = (e.clientX - box.left) / box.width;
			const y = (e.clientY - box.top) / box.height;
			const hit = (hlByPage.get(n) ?? []).find((h) => h.rects.some((r) => x >= r[0] && x <= r[2] && y >= r[1] && y <= r[3]));
			if (hit) {
				selMenu = null;
				const b = pagesEl!.getBoundingClientRect();
				hlMenu = { x: e.clientX - b.left, y: e.clientY - b.top - 8, h: hit };
			}
		}, 0);
	}

	function onPagesPointerDown(e: PointerEvent) {
		const t = e.target as HTMLElement;
		if (t.closest('.float-menu')) return;
		selMenu = null;
		hlMenu = null;
	}

	function clearSelection() {
		window.getSelection()?.removeAllRanges();
		selMenu = null;
	}

	// ------------------------------------------------------------ region

	let regionStart: { page: number; x: number; y: number } | null = null;

	function regionPoint(e: PointerEvent, page: number) {
		const el = pageState.get(page)!.el!;
		const box = el.getBoundingClientRect();
		return {
			x: Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
			y: Math.min(1, Math.max(0, (e.clientY - box.top) / box.height))
		};
	}

	function regionDown(e: PointerEvent, page: number) {
		(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
		const p = regionPoint(e, page);
		regionStart = { page, ...p };
		draftRegion = { page, rect: [p.x, p.y, p.x, p.y] };
		selMenu = null;
	}

	function regionMove(e: PointerEvent, page: number) {
		if (!regionStart || regionStart.page !== page) return;
		const p = regionPoint(e, page);
		draftRegion = {
			page,
			rect: [Math.min(regionStart.x, p.x), Math.min(regionStart.y, p.y), Math.max(regionStart.x, p.x), Math.max(regionStart.y, p.y)]
		};
	}

	function regionUp(e: PointerEvent, page: number) {
		if (!regionStart || !draftRegion) return;
		const r = draftRegion.rect;
		regionStart = null;
		if (r[2] - r[0] < 0.02 || r[3] - r[1] < 0.01) {
			draftRegion = null;
			return;
		}
		const rounded = r.map((v) => Math.round(v * 10000) / 10000);
		const anchor: AnchorInputClient = {
			documentId: doc.id,
			versionId: doc.versionId ?? '',
			page,
			kind: 'region',
			rects: [rounded],
			exact: textInRegion(pageState.get(page)?.text, rounded)
		};
		const el = pageState.get(page)!.el!;
		const box = el.getBoundingClientRect();
		const rect = new DOMRect(box.left + r[0] * box.width, box.top + r[1] * box.height, (r[2] - r[0]) * box.width, (r[3] - r[1]) * box.height);
		selMenu = { ...menuPos(rect), anchor };
		e.stopPropagation();
	}

	// ----------------------------------------------------------- actions

	async function refreshMarks() {
		try {
			const r = await api<{ marks: typeof data.marks; cardAnchors: typeof data.cardAnchors }>(`/api/library/${doc.id}`);
			highlights = r.marks.highlights;
			annotations = r.marks.annotations;
			cardAnchors = r.cardAnchors;
		} catch (err) {
			toastError(err);
		}
	}

	async function addHighlight(anchor: AnchorInputClient, c = color) {
		try {
			await api('/api/highlights', { body: { anchor, color: c } });
			clearSelection();
			draftRegion = null;
			await refreshMarks();
		} catch (err) {
			toastError(err);
		}
	}

	function sourceLabel(page: number) {
		const s = sectionFor(page);
		return [doc.title, s?.title, `p. ${page}`].filter(Boolean).join(' · ');
	}

	function openCard(opts: { anchor?: AnchorInputClient; anchorId?: string; page: number; passage: string }) {
		cardDraft = {
			kind: 'basic',
			fields: { Front: '', Back: opts.passage, Text: opts.passage, 'Back Extra': '' },
			aamcCode: defaultCode(opts.page),
			tags: []
		};
		cardContext = { passage: opts.passage, label: sourceLabel(opts.page), available: true };
		cardAnchor = opts.anchor ?? null;
		cardAnchorId = opts.anchorId ?? null;
		cardOpen = true;
		selMenu = null;
		hlMenu = null;
	}

	/** "Ask tutor" on a selection: a new conversation beside the book, about that passage. */
	function askTutorAbout(anchor: AnchorInputClient) {
		tutorAnchor = anchor;
		tutorThread = null;
		tutorMessages = [];
		tutorQuestion = '';
		tutorKey++;
		panel = 'tutor';
		selMenu = null;
		window.getSelection()?.removeAllRanges();
	}

	function openNote(opts: Partial<typeof noteState>) {
		noteState = { annotationId: null, body: '', quote: '', anchor: null, anchorId: null, documentId: doc.id, ...opts };
		noteOpen = true;
		selMenu = null;
		hlMenu = null;
	}

	async function recolor(h: Highlight, c: string) {
		try {
			await api('/api/highlights', { method: 'PATCH', body: { id: h.id, color: c } });
			hlMenu = null;
			await refreshMarks();
		} catch (err) {
			toastError(err);
		}
	}

	/** Saved highlights the selection touches (same page, overlapping on the same line). */
	function highlightsUnder(anchor: AnchorInputClient): Highlight[] {
		const touches = (r: number[], s: number[]) =>
			Math.min(r[2], s[2]) - Math.max(r[0], s[0]) > 0.002 && Math.min(r[3], s[3]) - Math.max(r[1], s[1]) > 0.5 * Math.min(r[3] - r[1], s[3] - s[1]);
		return (hlByPage.get(anchor.page) ?? []).filter((h) => h.rects.some((r) => anchor.rects.some((s) => touches(r, s))));
	}

	async function removeHighlights(list: Highlight[]) {
		try {
			for (const h of list) await api('/api/highlights', { method: 'PATCH', body: { id: h.id, delete: true } });
			hlMenu = null;
			clearSelection();
			draftRegion = null;
			toast(list.length === 1 ? 'Highlight removed' : `${list.length} highlights removed`);
		} catch (err) {
			toastError(err);
		}
		await refreshMarks();
	}

	async function copyText(text: string) {
		try {
			await navigator.clipboard.writeText(text);
			toast('Copied');
		} catch {
			toast('Copy failed', 'error');
		}
		clearSelection();
	}

	async function runSearch(e?: Event) {
		e?.preventDefault();
		const q = searchQ.trim();
		activeQuery = q;
		if (!q) {
			searchResults = [];
			return;
		}
		searching = true;
		try {
			const r = await api<{ results: typeof searchResults }>(`/api/library/${doc.id}?q=${encodeURIComponent(q)}`);
			searchResults = r.results;
		} catch (err) {
			toastError(err);
		} finally {
			searching = false;
		}
	}

	function hitRects(page: number): number[][] {
		void renderedTick;
		if (!activeQuery) return [];
		const t = pageState.get(page)?.text;
		if (!t) return [];
		return matchRanges(t.text, activeQuery).flatMap(([s, e]) => rectsForRange(t.runs as never, s, e));
	}

	// Book page style (Settings › Appearance): "match" follows the theme.
	const PAGE_OPTIONS = [{ id: 'match', name: 'Match theme' }, ...PAGE_STYLES] as const;
	const pageLabel = $derived(PAGE_STYLES.find((p) => p.id === appearance.pageStyle)?.name ?? '');

	// ------------------------------------------------------------- mount

	onMount(() => {
		searchQ = data.q;
		activeQuery = data.q;
		currentPage = data.initialPage;
		if (window.innerWidth >= 1200) panel = data.q ? 'search' : 'notes';
		const stopActivity = trackActivity('reading', () => doc.id);
		let io: IntersectionObserver | null = null;
		let pageIo: IntersectionObserver | null = null;
		let disposed = false;
		const onResize = () => {
			if (zoomMode === 'fit') void setScale(fitScale(), 'fit');
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				selMenu = null;
				hlMenu = null;
				draftRegion = null;
				if (regionMode) regionMode = false;
			}
		};
		const onSelChange = () => {
			const sel = window.getSelection();
			if (!sel || sel.isCollapsed) selMenu = selMenu?.anchor.kind === 'region' ? selMenu : null;
		};
		let lastWidth = 0;
		const ro = new ResizeObserver(() => {
			const w = scrollEl?.clientWidth ?? 0;
			if (Math.abs(w - lastWidth) > 4) {
				lastWidth = w;
				onResize();
			}
		});
		if (scrollEl) ro.observe(scrollEl);
		window.addEventListener('keydown', onKey);
		document.addEventListener('selectionchange', onSelChange);

		(async () => {
			if (doc.fileMissing || doc.status !== 'ready') {
				loading = false;
				return;
			}
			try {
				pdf = await openBook(doc.id);
			} catch (err) {
				loadError = err instanceof Error ? err.message : String(err);
				loading = false;
				return;
			}
			if (disposed) return;
			scale = fitScale();
			loading = false;
			await tick();
			io = new IntersectionObserver(
				(entries) => {
					for (const en of entries) {
						const n = Number((en.target as HTMLElement).dataset.page);
						if (en.isIntersecting) near.add(n);
						else {
							near.delete(n);
							unrender(n);
						}
					}
					schedule();
				},
				{ root: scrollEl, rootMargin: '150% 0px' }
			);
			pageIo = new IntersectionObserver(
				(entries) => {
					for (const en of entries) ratios.set(Number((en.target as HTMLElement).dataset.page), en.intersectionRatio);
					let best = currentPage;
					let bestRatio = -1;
					for (const [n, r] of ratios) {
						if (r > bestRatio || (r === bestRatio && n < best)) {
							best = n;
							bestRatio = r;
						}
					}
					if (bestRatio > 0) currentPage = best;
				},
				{ root: scrollEl, threshold: [0, 0.1, 0.25, 0.5, 0.75, 1] }
			);
			for (const s of pageState.values()) {
				if (s.el) {
					io.observe(s.el);
					pageIo.observe(s.el);
				}
			}
			await tick();
			if (data.target) await jumpTo(data.target.page, data.target.rects);
			else if (data.initialPage > 1) await jumpTo(data.initialPage, null, false);
		})();

		return () => {
			disposed = true;
			stopActivity();
			io?.disconnect();
			pageIo?.disconnect();
			ro.disconnect();
			window.removeEventListener('keydown', onKey);
			document.removeEventListener('selectionchange', onSelChange);
			for (const s of pageState.values()) s.task?.cancel();
		};
	});

	function bindPage(node: HTMLDivElement, n: number) {
		const s = st(n);
		s.el = node;
		s.canvasHost = node.querySelector('.canvas-host') as HTMLDivElement;
		s.layer = node.querySelector('.textLayer') as HTMLDivElement;
		return {
			destroy() {
				s.el = undefined;
			}
		};
	}
</script>

<svelte:head><title>{doc.title} · Medicus Vitae</title></svelte:head>

<div class="reader">
	<div class="toolbar">
		<div class="row-tight" style="min-width: 0; flex: 1 1 14rem; flex-wrap: nowrap">
			<a href={data.role === 'notes' ? '/notes' : `/library/${doc.id}`} class="icon-btn plain" aria-label={data.role === 'notes' ? 'Back to Notes' : 'Back to book details'}><Icon name="chevron-left" /></a>
			<div style="min-width: 0">
				<div class="strong truncate">{doc.title}</div>
				<div class="small muted truncate">{currentSection?.title ?? 'Reading'}{leaves.length > 1 ? ` · ${doneCount} of ${leaves.length} done` : ''}</div>
			</div>
			{#if currentLeaf && data.role !== 'notes'}
				{@const done = sectionDone(currentLeaf)}
				<button
					type="button"
					class="btn btn-sm done-btn"
					class:is-done={done}
					aria-pressed={done}
					title={done ? `${currentLeaf.title} is done (click to undo)` : `Mark ${currentLeaf.title} done`}
					onclick={() => setDone(currentLeaf, !done)}
				>
					<Icon name={done ? 'check-circle' : 'circle'} size={16} />{done ? 'Done' : 'Mark done'}
				</button>
			{/if}
		</div>
		<div class="row-tight" role="toolbar" aria-label="Reading tools">
			{#each COLORS as c (c.name)}
				<button
					type="button"
					class="icon-btn swatch-btn"
					aria-label="{c.label} highlighter"
					aria-pressed={color === c.name}
					onclick={() => (color = c.name)}
				>
					<span class="swatch hl-{c.name}"></span>
				</button>
			{/each}
			<span class="sep" aria-hidden="true"></span>
			<button
				type="button"
				class="btn btn-sm"
				class:active-tool={regionMode}
				aria-pressed={regionMode}
				title="Draw a box around a figure, table or equation"
				onclick={() => {
					regionMode = !regionMode;
					draftRegion = null;
					selMenu = null;
				}}
			>
				<Icon name="region" size={18} />Region
			</button>
			<button type="button" class="icon-btn" aria-label="Zoom out" onclick={() => zoom(-1)}><Icon name="zoom-out" size={18} /></button>
			<button type="button" class="btn btn-sm mono" style="min-width: 4.25rem" title="Fit to width" onclick={() => setScale(fitScale(), 'fit')}>
				{zoomMode === 'fit' ? 'Fit' : `${Math.round(scale * 100)}%`}
			</button>
			<button type="button" class="icon-btn" aria-label="Zoom in" onclick={() => zoom(1)}><Icon name="zoom-in" size={18} /></button>
			<label class="page-style btn btn-sm" title="Page style (separate from the app theme)">
				<span>Page:</span>
				<select
					aria-label="Page style"
					value={appearance.account.page}
					onchange={(e) => setAccountAppearance({ page: (e.currentTarget as HTMLSelectElement).value as never })}
				>
					{#each PAGE_OPTIONS as o (o.id)}<option value={o.id}>{o.id === 'match' ? `Match theme (${pageLabel})` : o.name}</option>{/each}
				</select>
			</label>
			<span class="sep" aria-hidden="true"></span>
			<button type="button" class="icon-btn" aria-label="Search this book" aria-pressed={panel === 'search'} onclick={() => (panel = panel === 'search' ? null : 'search')}><Icon name="search" size={18} /></button>
			<button type="button" class="icon-btn" aria-label="Contents" aria-pressed={panel === 'contents'} onclick={() => (panel = panel === 'contents' ? null : 'contents')}><Icon name="list" size={18} /></button>
			{#if data.ai}<button type="button" class="icon-btn" aria-label="Tutor" aria-pressed={panel === 'tutor'} onclick={() => (panel = panel === 'tutor' ? null : 'tutor')}><Icon name="sparkle" size={18} /></button>{/if}
			<button type="button" class="icon-btn" aria-label="Notes" aria-pressed={panel === 'notes'} onclick={() => (panel = panel === 'notes' ? null : 'notes')}><Icon name="note" size={18} /></button>
		</div>
	</div>

	{#if pageNotes.length}
		<div class="linked-bar" role="note">
			<Icon name="note" size={15} />
			<span class="small strong">{data.role === 'notes' ? 'This covers' : 'Your notes for this page'}:</span>
			{#each pageNotes as l (l.id)}
				<a class="source-chip linked-chip" href={l.href}>{l.text}</a>
			{/each}
		</div>
	{/if}

	<div class="body">
		<div class="scroll" bind:this={scrollEl} data-page={appearance.pageStyle}>
			{#if doc.fileMissing}
				<div class="card empty" style="margin: 2rem auto; max-width: 34rem">
					<Icon name="alert" size={28} />
					<h2>The book file is missing</h2>
					<p>Medicus Vitae can’t find the original PDF in its data folder. Your cards, highlights and notes keep their copied text.</p>
					{#if data.target}<blockquote class="reading quote-box">{data.target.exact}</blockquote>{/if}
				</div>
			{:else if doc.status !== 'ready'}
				<div class="card empty" style="margin: 2rem auto; max-width: 34rem">
					<Icon name="refresh" size={28} />
					<h2>{doc.status === 'failed' ? 'This book couldn’t be processed' : 'Still processing'}</h2>
					<p>{doc.status === 'failed' ? doc.error : 'Text extraction is running in the background. This page will work when it’s done.'}</p>
					<a class="btn" href="/library/{doc.id}">Book details</a>
				</div>
			{:else if loadError}
				<div class="card empty" style="margin: 2rem auto; max-width: 34rem">
					<Icon name="alert" size={28} />
					<h2>Couldn’t open the PDF</h2>
					<p>{loadError}</p>
				</div>
			{:else}
				{#if doc.notice}<div class="warning" style="margin: 1rem auto; max-width: 48rem"><Icon name="info" size={18} />{doc.notice}</div>{/if}
				{#if loading}<div class="muted small" style="text-align: center; padding: 2rem">Opening the book…</div>{/if}
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div class="pages" bind:this={pagesEl} onpointerup={onPagesPointerUp} onpointerdown={onPagesPointerDown} onkeyup={() => checkSelection()}>
					{#each data.pages as p (p.page)}
						<div
							class="pdf-page"
							data-page={p.page}
							use:bindPage={p.page}
							style="width: {p.width * scale}px; height: {p.height * scale}px; --scale-factor: {scale}; --total-scale-factor: {scale}; --scale-round-x: 1px; --scale-round-y: 1px;"
						>
							<div class="canvas-host"></div>
							<div class="marks" aria-hidden="true">
								{#each hlByPage.get(p.page) ?? [] as h (h.id)}
									{#each h.rects as r, i (i)}
										<div class="hl hl-{h.color}" style="left: {r[0] * 100}%; top: {r[1] * 100}%; width: {(r[2] - r[0]) * 100}%; height: {(r[3] - r[1]) * 100}%"></div>
									{/each}
								{/each}
								{#each hitRects(p.page) as r, i (i)}
									<div class="hit" style="left: {r[0] * 100}%; top: {r[1] * 100}%; width: {(r[2] - r[0]) * 100}%; height: {(r[3] - r[1]) * 100}%"></div>
								{/each}
								{#if flash?.page === p.page}
									{#each flash.rects as r, i (i)}
										<div class="flash" style="left: {r[0] * 100}%; top: {r[1] * 100}%; width: {(r[2] - r[0]) * 100}%; height: {(r[3] - r[1]) * 100}%"></div>
									{/each}
								{/if}
								{#if draftRegion?.page === p.page}
									{@const r = draftRegion.rect}
									<div class="region-box" style="left: {r[0] * 100}%; top: {r[1] * 100}%; width: {(r[2] - r[0]) * 100}%; height: {(r[3] - r[1]) * 100}%"></div>
								{/if}
							</div>
							<div class="textLayer"></div>
							{#if regionMode}
								<div
									class="region-capture"
									role="presentation"
									onpointerdown={(e) => regionDown(e, p.page)}
									onpointermove={(e) => regionMove(e, p.page)}
									onpointerup={(e) => regionUp(e, p.page)}
								></div>
							{/if}
							<div class="margin">
								{#each notesByPage.get(p.page) ?? [] as a (a.id)}
									<button
										type="button"
										class="margin-btn note-mark"
										style="top: {(a.rects?.[0]?.[1] ?? 0) * 100}%"
										aria-label="Note on page {p.page}"
										onclick={() => openNote({ annotationId: a.id, body: a.body, quote: a.exact, anchorId: a.anchorId })}
									>
										<Icon name="note" size={14} stroke={2} />
									</button>
								{/each}
								{#each cardsByPage.get(p.page) ?? [] as c (c.noteId)}
									<a
										class="margin-btn card-mark"
										style="top: {(c.rects?.[0]?.[1] ?? 0) * 100}%"
										href="/cards?note={c.noteId}"
										title={notePreview(kindForNoteType(c.noteTypeId), c.fields)}
										aria-label="Card made from this passage"
									>
										<Icon name="cards" size={14} stroke={2} />
									</a>
								{/each}
							</div>
							<div class="page-num mono" aria-hidden="true">{p.page}</div>
						</div>
					{/each}

					{#if selMenu}
						{@const under = highlightsUnder(selMenu.anchor)}
						<div class="float-menu" role="toolbar" aria-label="Selection actions" style="left: {selMenu.x}px; top: {selMenu.y}px">
							<button type="button" onclick={() => addHighlight(selMenu!.anchor)}><span class="swatch hl-{color}"></span>Highlight</button>
							{#if under.length}<button type="button" onclick={() => removeHighlights(under)}>Unhighlight</button>{/if}
							<button type="button" onclick={() => openNote({ anchor: selMenu!.anchor, quote: selMenu!.anchor.exact ?? '' })}>Note</button>
							<button type="button" class="primary" onclick={() => openCard({ anchor: selMenu!.anchor, page: selMenu!.anchor.page, passage: selMenu!.anchor.exact ?? '' })}>Make card</button>
							{#if data.ai && (selMenu.anchor.exact ?? '').trim()}<button type="button" onclick={() => askTutorAbout(selMenu!.anchor)}><Icon name="sparkle" size={15} />Ask tutor</button>{/if}
							{#if selMenu.anchor.exact}<button type="button" onclick={() => copyText(selMenu!.anchor.exact ?? '')}>Copy</button>{/if}
						</div>
					{/if}
					{#if hlMenu}
						<div class="float-menu" role="toolbar" aria-label="Highlight actions" style="left: {hlMenu.x}px; top: {hlMenu.y}px">
							{#each COLORS as c (c.name)}
								<button type="button" class="swatch-only" aria-label="Make it {c.label.toLowerCase()}" onclick={() => recolor(hlMenu!.h, c.name)}><span class="swatch hl-{c.name}"></span></button>
							{/each}
							<button type="button" onclick={() => openNote({ anchorId: hlMenu!.h.anchorId, quote: hlMenu!.h.exact })}>Note</button>
							<button type="button" class="primary" onclick={() => openCard({ anchorId: hlMenu!.h.anchorId, page: hlMenu!.h.page, passage: hlMenu!.h.exact })}>Make card</button>
							<button type="button" onclick={() => removeHighlights([hlMenu!.h])}>Unhighlight</button>
						</div>
					{/if}
				</div>
			{/if}
		</div>

		{#if panel}
			<aside class="panel" aria-label="Reader panel">
				<div class="panel-head">
					<div class="segmented" role="tablist">
						<button type="button" role="tab" aria-selected={panel === 'notes'} onclick={() => (panel = 'notes')}>Notes</button>
						<button type="button" role="tab" aria-selected={panel === 'contents'} onclick={() => (panel = 'contents')}>Contents</button>
						<button type="button" role="tab" aria-selected={panel === 'search'} onclick={() => (panel = 'search')}>Search</button>
						{#if data.ai}<button type="button" role="tab" aria-selected={panel === 'tutor'} onclick={() => (panel = 'tutor')}>Tutor</button>{/if}
					</div>
					<button type="button" class="icon-btn plain" aria-label="Close panel" onclick={() => (panel = null)}><Icon name="x" size={18} /></button>
				</div>
				<div class="panel-body">
					{#if panel === 'notes'}
						<button type="button" class="btn btn-sm" onclick={() => openNote({})}><Icon name="plus" size={16} />Note on this book</button>
						{#each bookNotes as a (a.id)}
							<div class="note-item">
								<div class="tiny muted strong">Book note</div>
								<div class="md small">{@html renderMarkdown(a.body)}</div>
								<div class="row-tight"><button type="button" class="btn btn-ghost btn-sm" onclick={() => openNote({ annotationId: a.id, body: a.body })}>Edit</button></div>
							</div>
						{/each}
						{#each sortedNotes as a (a.id)}
							<div class="note-item">
								<button type="button" class="link-btn tiny strong" onclick={() => jumpTo(a.page!, a.rects)}>Page {a.page}</button>
								{#if a.exact}<blockquote class="reading">{a.exact.length > 160 ? a.exact.slice(0, 159) + '…' : a.exact}</blockquote>{/if}
								<div class="md small">{@html renderMarkdown(a.body)}</div>
								<div class="row-tight">
									<button type="button" class="btn btn-ghost btn-sm" onclick={() => openNote({ annotationId: a.id, body: a.body, quote: a.exact, anchorId: a.anchorId })}>Edit</button>
								</div>
							</div>
						{:else}
							{#if !bookNotes.length}<p class="small muted">Select text and choose Note, or add a note on the whole book.</p>{/if}
						{/each}
						{#if highlights.length}
							<div class="tiny muted strong" style="margin-top: 0.5rem">Highlights · {highlights.length}</div>
							{#each [...highlights].sort((a, b) => a.page - b.page) as h (h.id)}
								<button type="button" class="hl-item" onclick={() => jumpTo(h.page, h.rects)}>
									<span class="swatch hl-{h.color}"></span>
									<span class="small" style="flex: 1 1 auto; text-align: left">{h.kind === 'region' ? `Figure region${h.exact ? `: ${h.exact.slice(0, 60)}` : ''}` : h.exact.slice(0, 120)}{h.exact.length > 120 ? '…' : ''}</span>
									<span class="tiny muted mono">p{h.page}</span>
								</button>
							{/each}
						{/if}
					{:else if panel === 'tutor'}
						<div class="tutor-panel">
							{#key tutorKey}
								<TutorChat
									compact
									bind:threadId={tutorThread}
									bind:messages={tutorMessages}
									anchor={tutorAnchor}
									initialQuestion={tutorQuestion}
									context={tutorAnchor
										? { kind: 'selection', documentId: doc.id, page: tutorAnchor.page, label: `“${(tutorAnchor.exact ?? '').slice(0, 70)}${(tutorAnchor.exact ?? '').length > 70 ? '…' : ''}”` }
										: { kind: 'page', documentId: doc.id, page: currentPage, label: `${doc.title} · p. ${currentPage}` }}
								/>
							{/key}
							{#if tutorThread}<a class="tiny" href="/tutor?t={tutorThread}">Open this conversation in the Tutor</a>{/if}
						</div>
					{:else if panel === 'contents'}
						{#each data.sections as s (s.id)}
							{@const done = sectionDone(s)}
							<div class="toc-row" style="padding-left: {s.level * 1}rem">
								<button type="button" class="toc-check" class:done aria-label="{s.title}: {done ? 'done (click to undo)' : 'mark done'}" title={done ? 'Done' : 'Mark done'} onclick={() => setDone(s, !done)}>
									<Icon name={done ? 'check-circle' : 'circle'} size={15} />
								</button>
								<button type="button" class="toc-item" onclick={() => jumpTo(s.pageStart)} aria-current={currentSection?.id === s.id ? 'true' : undefined}>
									<span class="small" class:muted={done} style="flex: 1 1 auto; text-align: left">{s.title}</span>
									{#each s.aamcCodes as c (c)}<span class="code-tag">{c}</span>{/each}
									<span class="tiny muted mono">{s.pageStart}</span>
								</button>
							</div>
						{/each}
						<a class="btn btn-sm" href="/library/{doc.id}">Chapters, progress &amp; AAMC tags</a>
					{:else}
						<form class="row-tight" onsubmit={runSearch} role="search">
							<label for="book-search" class="sr-only">Search this book</label>
							<input id="book-search" class="input" style="flex: 1 1 10rem" bind:value={searchQ} placeholder="Search this book" />
							<button class="btn btn-sm">Search</button>
						</form>
						{#if searching}<p class="small muted">Searching…</p>{/if}
						{#if activeQuery && !searching}
							<p class="tiny muted">{searchResults.length} page{searchResults.length === 1 ? '' : 's'} match “{activeQuery}”</p>
						{/if}
						{#each searchResults as r (r.page)}
							<button type="button" class="search-item" onclick={() => jumpTo(r.page)}>
								<span class="tiny muted mono strong">Page {r.page}</span>
								<span class="small">{#each r.segments as seg, i (i)}{#if seg.hit}<mark>{seg.text}</mark>{:else}{seg.text}{/if}{/each}</span>
							</button>
						{/each}
					{/if}
				</div>
			</aside>
		{/if}
	</div>

	<div class="statusbar">
		<form
			class="row-tight"
			onsubmit={(e) => {
				e.preventDefault();
				const n = Math.max(1, Math.min(doc.pageCount || 1, Number(pageInput) || 1));
				void jumpTo(n, null, false);
			}}
		>
			<label for="page-jump" class="small muted">Page</label>
			<input id="page-jump" class="input mono" style="width: 4.5rem; min-height: 32px; padding: 0 0.5rem" bind:value={pageInput} inputmode="numeric" />
			<span class="small muted">of {doc.pageCount}</span>
		</form>
		{#if regionMode}<span class="small strong" style="color: var(--accent-text)">Drag a box around a figure, table or equation. Esc to stop.</span>{/if}
		{#if endPrompt && !regionMode}
			<div class="end-prompt" role="status">
				<Icon name="check-circle" size={16} />
				<span class="small">End of <strong>{endPrompt.title}</strong>. Mark it done?</span>
				<button type="button" class="btn btn-sm btn-primary" onclick={() => setDone(endPrompt, true)}>Mark done</button>
				<button type="button" class="btn btn-sm btn-ghost" onclick={() => (promptDismissed = { ...promptDismissed, [endPrompt.id]: true })}>Not yet</button>
			</div>
		{/if}
	</div>
</div>

<CardEditor bind:open={cardOpen} draft={cardDraft} context={cardContext} anchor={cardAnchor} anchorId={cardAnchorId} onsaved={() => { clearSelection(); draftRegion = null; void refreshMarks(); }} />
<AnnotationEditor
	bind:open={noteOpen}
	annotationId={noteState.annotationId}
	body={noteState.body}
	quote={noteState.quote}
	anchor={noteState.anchor}
	anchorId={noteState.anchorId}
	documentId={noteState.documentId}
	onsaved={() => { clearSelection(); draftRegion = null; void refreshMarks(); }}
	ondeleted={() => void refreshMarks()}
/>

<style>
	.reader {
		display: flex;
		flex-direction: column;
		height: 100vh;
		min-height: 0;
	}
	@media (max-width: 900px) {
		.reader {
			height: calc(100vh - 57px - 64px);
		}
	}
	.toolbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem 0.75rem;
		padding: 0.5rem 1rem;
		background: var(--surface);
		border-bottom: 1px solid var(--border);
	}
	.linked-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 0.375rem 0.5rem;
		padding: 0.375rem 1rem;
		background: var(--accent-soft);
		color: var(--accent-text);
		border-bottom: 1px solid var(--border);
	}
	.linked-chip {
		padding: 0.1875rem 0.625rem;
		background: var(--surface);
	}
	.sep {
		width: 1px;
		height: 28px;
		background: var(--border);
		margin: 0 0.25rem;
	}
	.swatch {
		width: 18px;
		height: 18px;
		border-radius: 999px;
		display: inline-block;
		border: 1px solid var(--border-strong);
		flex: none;
	}
	.page-style {
		gap: 0.25rem;
		padding-right: 0.25rem;
	}
	.page-style select {
		border: 0;
		background: transparent;
		color: var(--text);
		font-weight: 600;
		cursor: pointer;
		max-width: 11rem;
	}
	.page-style select option {
		background: var(--surface);
		color: var(--text);
	}
	.swatch-btn[aria-pressed='true'] {
		border: 2px solid var(--text);
	}
	.hl-yellow {
		background: var(--hl-yellow);
	}
	.hl-teal {
		background: var(--hl-teal);
	}
	.hl-pink {
		background: var(--hl-pink);
	}
	.hl-blue {
		background: var(--hl-blue);
	}
	.active-tool {
		background: var(--ink);
		color: var(--on-ink);
		border-color: var(--ink);
	}
	.active-tool:hover {
		background: var(--ink-hover);
		color: var(--on-ink);
	}
	.body {
		flex: 1 1 auto;
		display: flex;
		min-height: 0;
		position: relative;
	}
	.scroll {
		flex: 1 1 auto;
		overflow: auto;
		background: var(--bg);
		min-width: 0;
	}
	.pages {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 1rem;
		padding: 1.25rem 0.5rem 4rem;
		width: max-content;
		min-width: 100%;
	}
	/* The page style (data-page on .scroll) filters only the page's canvas (themes.css);
	   highlights, notes and search marks sit above it, unfiltered, in the page's own colors. */
	.pdf-page {
		position: relative;
		background: var(--page-bg);
		box-shadow: var(--shadow);
		border-radius: 2px;
		flex: none;
	}
	.canvas-host,
	.marks {
		position: absolute;
		inset: 0;
	}
	.canvas-host :global(canvas) {
		width: 100%;
		height: 100%;
		display: block;
	}
	.marks {
		pointer-events: none;
	}
	.hl,
	.hit,
	.flash,
	.region-box {
		position: absolute;
		border-radius: 2px;
	}
	/* Light pages: highlights multiply into the paper like a marker. Inverted (dark) pages:
	   screen, so the highlight shows behind the light text. */
	.hl,
	.hit {
		mix-blend-mode: multiply;
	}
	.scroll[data-page='inverted'] .hl,
	.scroll[data-page='inverted'] .hit {
		mix-blend-mode: screen;
	}
	.hl {
		opacity: 0.9;
	}
	.marks .hl-yellow {
		background: var(--page-hl);
	}
	.marks .hl-blue {
		background: var(--page-hl-2);
	}
	/* Teal and pink: the page's own highlight lightness, turned to their hue. */
	.marks .hl-teal {
		background: var(--page-hl-2);
		background: oklch(from var(--page-hl-2) l c 185);
	}
	.marks .hl-pink {
		background: var(--page-hl);
		background: oklch(from var(--page-hl) l c 355);
	}
	.hit {
		background: color-mix(in srgb, var(--page-hl) 60%, transparent);
		outline: 1px solid var(--accent);
	}
	.flash {
		outline: 3px solid var(--accent);
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		animation: flash 2.4s ease-out forwards;
	}
	@keyframes flash {
		0%,
		60% {
			opacity: 1;
		}
		100% {
			opacity: 0;
		}
	}
	.region-box {
		border: 2px dashed var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}
	.region-capture {
		position: absolute;
		inset: 0;
		z-index: 3;
		cursor: crosshair;
		touch-action: none;
	}
	.margin {
		position: absolute;
		top: 0;
		bottom: 0;
		right: -34px;
		width: 30px;
	}
	.margin-btn {
		position: absolute;
		left: 0;
		width: 28px;
		height: 28px;
		border-radius: 8px;
		display: flex;
		align-items: center;
		justify-content: center;
		border: 1px solid var(--border);
		cursor: pointer;
		box-shadow: var(--shadow);
	}
	.note-mark {
		background: var(--page-note-bg);
		color: var(--page-note-text);
	}
	.card-mark {
		background: var(--accent-soft);
		color: var(--accent-text);
		transform: translateY(32px);
	}
	.page-num {
		position: absolute;
		bottom: -1.1rem;
		left: 50%;
		transform: translateX(-50%);
		font-size: 0.6875rem;
		color: var(--text-3);
	}
	.float-menu {
		position: absolute;
		z-index: 20;
		transform: translate(-50%, calc(-100% - 10px));
		display: flex;
		gap: 2px;
		padding: 4px;
		background: var(--ink);
		border-radius: 10px;
		box-shadow: var(--shadow-lg);
		white-space: nowrap;
	}
	.float-menu button {
		min-height: 36px;
		padding: 0 0.75rem;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: var(--on-ink);
		font-size: 0.8125rem;
		font-weight: 600;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		gap: 0.375rem;
	}
	.float-menu button:hover,
	.float-menu button.primary {
		background: var(--ink-hover);
	}
	.float-menu .swatch-only {
		padding: 0 0.5rem;
	}
	.panel {
		flex: 0 0 22rem;
		width: 22rem;
		border-left: 1px solid var(--border);
		background: var(--surface);
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	@media (max-width: 1100px) {
		.panel {
			position: absolute;
			right: 0;
			top: 0;
			bottom: 0;
			z-index: 25;
			width: min(22rem, 92vw);
			box-shadow: var(--shadow-lg);
		}
	}
	.panel-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 0.5rem;
		padding: 0.625rem 0.75rem;
		border-bottom: 1px solid var(--border);
	}
	.panel-body {
		flex: 1 1 auto;
		overflow-y: auto;
		padding: 0.875rem;
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.tutor-panel {
		flex: 1 1 auto;
		min-height: 22rem;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
	}
	.note-item {
		background: var(--hl-yellow);
		color: var(--text);
		border-radius: var(--radius);
		padding: 0.75rem 0.875rem;
		display: flex;
		flex-direction: column;
		gap: 0.375rem;
	}
	.note-item blockquote {
		margin: 0;
		font-size: 0.8125rem;
		opacity: 0.85;
		border-left: 2px solid currentColor;
		padding-left: 0.5rem;
	}
	.note-item .btn-ghost {
		color: inherit;
	}
	.link-btn {
		background: none;
		border: 0;
		padding: 0;
		color: var(--accent-text);
		cursor: pointer;
		text-align: left;
	}
	.toc-row {
		display: flex;
		align-items: center;
		gap: 0.125rem;
	}
	.toc-row .toc-item {
		flex: 1 1 auto;
		min-width: 0;
	}
	.toc-check {
		flex: none;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 1.75rem;
		height: 1.75rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text-3);
		cursor: pointer;
	}
	.toc-check:hover {
		background: var(--surface-2);
		color: var(--text);
	}
	.toc-check.done {
		color: var(--accent-text);
	}
	.done-btn {
		flex: none;
	}
	.done-btn.is-done {
		color: var(--accent-text);
		border-color: var(--accent-border);
		background: var(--accent-soft);
	}
	.end-prompt {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		margin-left: auto;
		padding: 0.125rem 0.25rem 0.125rem 0.625rem;
		border-radius: var(--radius);
		background: var(--accent-soft);
		color: var(--accent-text);
	}
	.hl-item,
	.toc-item,
	.search-item {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		width: 100%;
		min-height: 2.25rem;
		padding: 0.375rem 0.5rem;
		border: 0;
		border-radius: var(--radius-sm);
		background: transparent;
		color: var(--text);
		cursor: pointer;
	}
	.search-item {
		flex-direction: column;
		align-items: flex-start;
		text-align: left;
		border-bottom: 1px solid var(--border);
		border-radius: 0;
	}
	.hl-item:hover,
	.toc-item:hover,
	.search-item:hover {
		background: var(--surface-2);
	}
	.toc-item[aria-current='true'] {
		background: var(--accent-soft);
	}
	.search-item :global(mark) {
		background: var(--hl-yellow);
		color: var(--text);
		border-radius: 3px;
		padding: 0 2px;
	}
	.statusbar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 1rem;
		padding: 0.375rem 1rem;
		background: var(--surface);
		border-top: 1px solid var(--border);
	}
	.quote-box {
		margin: 0;
		padding: 0.75rem;
		background: var(--surface-2);
		border-radius: var(--radius);
		text-align: left;
		color: var(--text);
	}

	/* PDF.js text layer (selection over the canvas). */
	.pdf-page :global(.textLayer) {
		color-scheme: only light;
		position: absolute;
		text-align: initial;
		inset: 0;
		overflow: clip;
		opacity: 1;
		line-height: 1;
		letter-spacing: normal;
		word-spacing: normal;
		text-size-adjust: none;
		forced-color-adjust: none;
		transform-origin: 0 0;
		caret-color: CanvasText;
		z-index: 2;
		--min-font-size: 1;
		--text-scale-factor: calc(var(--total-scale-factor) * var(--min-font-size));
		--min-font-size-inv: calc(1 / var(--min-font-size));
	}
	.pdf-page :global(.textLayer :is(span, br)) {
		color: transparent;
		position: absolute;
		white-space: pre;
		cursor: text;
		transform-origin: 0% 0%;
		user-select: text;
	}
	.pdf-page :global(.textLayer > :not(.markedContent)),
	.pdf-page :global(.textLayer .markedContent span:not(.markedContent)) {
		z-index: 1;
		--font-height: 0;
		font-size: calc(var(--text-scale-factor) * var(--font-height));
		--scale-x: 1;
		--rotate: 0deg;
		transform: rotate(var(--rotate)) scaleX(var(--scale-x)) scale(var(--min-font-size-inv));
	}
	.pdf-page :global(.textLayer .markedContent) {
		display: contents;
	}
	.pdf-page :global(.textLayer ::selection) {
		background: color-mix(in srgb, var(--page-hl-2) 70%, transparent);
		color: transparent;
	}
	.pdf-page :global(.textLayer br::selection) {
		background: transparent;
	}
	.pdf-page :global(.textLayer .endOfContent) {
		display: block;
		position: absolute;
		inset: 100% 0 0;
		z-index: 0;
		cursor: default;
		user-select: none;
	}
	.pdf-page :global(.textLayer.selecting .endOfContent) {
		top: 0;
	}
</style>
