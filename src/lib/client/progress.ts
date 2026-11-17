import { api } from '#lib/client/api.js';
import { toast, toastAction, toastError } from '#lib/client/toast.svelte.js';
import type { BookProgress, PageRange } from '#lib/ranges.js';

export interface ProgressResult {
	ranges: PageRange[];
	previous: PageRange[];
	progress: BookProgress;
	cards: { batchId: string; unsuspended: number; suspended: number } | null;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What a progress change did, with an Undo that puts back the progress and the cards. */
export function progressToast(documentId: string, message: string, r: ProgressResult, after?: () => void | Promise<void>) {
	const cards = r.cards;
	const extra = cards
		? [cards.unsuspended ? `${plural(cards.unsuspended, 'card')} unsuspended` : '', cards.suspended ? `${plural(cards.suspended, 'card')} suspended` : '']
				.filter(Boolean)
				.join(', ')
		: '';
	toastAction(extra ? `${message} · ${extra}` : message, {
		label: 'Undo',
		run: async () => {
			try {
				await api(`/api/library/${documentId}`, { body: { action: 'undo-progress', ranges: r.previous, undoBatch: cards?.batchId ?? null } });
				toast('Undone');
				await after?.();
			} catch (err) {
				toastError(err);
			}
		}
	});
}

export async function markSections(documentId: string, sectionIds: string[], done: boolean, label: string, after?: () => void | Promise<void>) {
	try {
		const r = await api<ProgressResult>(`/api/library/${documentId}`, { body: { action: 'mark-sections', sectionIds, done } });
		await after?.();
		progressToast(documentId, done ? `${label} done` : `${label} not done`, r, after);
		return r;
	} catch (err) {
		toastError(err);
		return null;
	}
}
