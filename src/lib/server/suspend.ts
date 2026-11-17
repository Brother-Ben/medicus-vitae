import { db, inTx, sqlite } from './db';
import { cardSuspendChange } from './db/schema';
import { uuidv7 } from './ids';

// Suspending and unsuspending cards, by hand or by a book linked to a deck.
// Every change is logged (card_suspend_change): one batch can be undone as a
// whole, a card someone suspended by hand is never unsuspended by a book, and
// the Anki sync sends the changes to Anki (suspend/unsuspend there too).

export type SuspendSource = 'manual' | 'book' | 'undo';

export interface SuspendResult {
	batchId: string;
	changed: number;
}

function chunks<T>(xs: T[], n = 500): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
	return out;
}

/** Sets cards suspended or not, logging each change. Cards already that way are left alone (and not logged). */
export function changeSuspension(cardIds: string[], suspended: boolean, opts: { source: SuspendSource; reason?: string; batchId?: string }): SuspendResult {
	const batchId = opts.batchId ?? uuidv7();
	const ids = [...new Set(cardIds)];
	let changed = 0;
	if (!ids.length) return { batchId, changed };
	const now = Date.now();
	inTx(() => {
		const update = sqlite().prepare('UPDATE card SET suspended = ?, updated_at = ? WHERE id = ?');
		for (const part of chunks(ids)) {
			const rows = sqlite()
				.prepare(`SELECT id, suspended FROM card WHERE deleted_at IS NULL AND id IN (${part.map(() => '?').join(',')})`)
				.all(...part) as { id: string; suspended: number }[];
			for (const r of rows) {
				if (!!r.suspended === suspended) continue;
				update.run(suspended ? 1 : 0, now, r.id);
				db()
					.insert(cardSuspendChange)
					.values({ id: uuidv7(), cardId: r.id, suspended, prev: !!r.suspended, source: opts.source, batchId, reason: (opts.reason ?? '').slice(0, 200), changedAt: now })
					.run();
				changed++;
			}
		}
	});
	return { batchId, changed };
}

/**
 * Puts a batch back: each card goes back to how it was before the batch, unless
 * it was changed again since (then it's left as it is). Returns how many moved.
 */
export function undoSuspendBatch(batchId: string): SuspendResult {
	const rows = sqlite()
		.prepare('SELECT id, card_id, suspended, prev FROM card_suspend_change WHERE batch_id = ? ORDER BY id')
		.all(batchId) as { id: string; card_id: string; suspended: number; prev: number }[];
	if (!rows.length) return { batchId: '', changed: 0 };
	const first = new Map<string, number>();
	const last = new Map<string, { id: string; suspended: number }>();
	for (const r of rows) {
		if (!first.has(r.card_id)) first.set(r.card_id, r.prev);
		last.set(r.card_id, { id: r.id, suspended: r.suspended });
	}
	const latest = latestChanges([...last.keys()]);
	const back = { on: [] as string[], off: [] as string[] };
	for (const [cardId, l] of last) {
		// Changed again after this batch: leave it.
		if (latest.get(cardId)?.id !== l.id) continue;
		(first.get(cardId) ? back.on : back.off).push(cardId);
	}
	const undoId = uuidv7();
	const a = changeSuspension(back.on, true, { source: 'undo', reason: 'Undo', batchId: undoId });
	const b = changeSuspension(back.off, false, { source: 'undo', reason: 'Undo', batchId: undoId });
	return { batchId: undoId, changed: a.changed + b.changed };
}

/** The most recent logged change of each card (ids are time-ordered). */
export function latestChanges(cardIds?: string[]): Map<string, { id: string; source: string; suspended: boolean }> {
	const out = new Map<string, { id: string; source: string; suspended: boolean }>();
	const q = (ids: string[] | null) =>
		sqlite()
			.prepare(
				`SELECT c.card_id, c.id, c.source, c.suspended FROM card_suspend_change c
				 JOIN (SELECT card_id, max(id) AS mid FROM card_suspend_change ${ids ? `WHERE card_id IN (${ids.map(() => '?').join(',')})` : ''} GROUP BY card_id) m ON m.mid = c.id`
			)
			.all(...(ids ?? [])) as { card_id: string; id: string; source: string; suspended: number }[];
	const rows = cardIds ? chunks([...new Set(cardIds)]).flatMap((part) => q(part)) : q(null);
	for (const r of rows) out.set(r.card_id, { id: r.id, source: r.source, suspended: !!r.suspended });
	return out;
}

/** Suspension changes made here that Anki doesn't have yet: the latest per card that Anki knows. */
export function pendingAnkiSuspensions() {
	const rows = sqlite()
		.prepare(
			`SELECT s.id, s.card_id, s.suspended, c.anki_card_id FROM card_suspend_change s JOIN card c ON c.id = s.card_id
			 WHERE s.anki_pushed_at IS NULL AND c.deleted_at IS NULL ORDER BY s.id`
		)
		.all() as { id: string; card_id: string; suspended: number; anki_card_id: number | null }[];
	const final = new Map<string, { suspended: boolean; anki: number | null }>();
	for (const r of rows) final.set(r.card_id, { suspended: !!r.suspended, anki: r.anki_card_id });
	const suspend: number[] = [];
	const unsuspend: number[] = [];
	for (const v of final.values()) {
		if (!v.anki || v.anki <= 0) continue;
		(v.suspended ? suspend : unsuspend).push(v.anki);
	}
	return { suspend, unsuspend, changeIds: rows.map((r) => r.id) };
}

export function markSuspensionsPushed(changeIds: string[]) {
	const now = Date.now();
	inTx(() => {
		for (const part of chunks(changeIds)) {
			sqlite()
				.prepare(`UPDATE card_suspend_change SET anki_pushed_at = ? WHERE id IN (${part.map(() => '?').join(',')})`)
				.run(now, ...part);
		}
	});
}

export function batchSummary(batchId: string) {
	const r = sqlite()
		.prepare('SELECT sum(suspended = 0) AS unsuspended, sum(suspended = 1) AS suspended FROM card_suspend_change WHERE batch_id = ?')
		.get(batchId) as { unsuspended: number | null; suspended: number | null };
	return { batchId, unsuspended: r.unsuspended ?? 0, suspended: r.suspended ?? 0 };
}
