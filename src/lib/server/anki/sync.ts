import fs from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { diffDays } from '../../dates';
import { renderMarkdown } from '../../markdown';
import { requestIndex } from '../ai/indexer';
import { mergeImportedReviews, type ImportedReview } from '../cards';
import { config } from '../config';
import { db, inTx, kvGet, kvSet, sqlite } from '../db';
import { ankiSyncDeck, noteType } from '../db/schema';
import { uuidv7 } from '../ids';
import { role } from '../instance';
import { studyClock, studyDayFor } from '../settings';
import { markSuspensionsPushed, pendingAnkiSuspensions } from '../suspend';
import { ankiConnectConfig, AnkiConnectError, ankiStatus, invoke, type AnkiConnectConfig } from './connect';
import { applyPackage, noteHash } from './importer';

// Two-way sync with the owner's Anki profile through AnkiConnect, and with
// Anki on their phone through Anki desktop's own AnkiWeb sync:
//
//   phone ⇄ AnkiWeb ⇄ Anki desktop ⇄ (AnkiConnect) ⇄ Medicus
//
// Each run:
//  1. Anki desktop syncs with AnkiWeb (brings in reviews and cards from the phone).
//  2. For each synced deck: if Anki has new or changed notes, the deck is exported
//     and read in with the regular Anki importer (note types, media, history:
//     nothing is lost). Then new reviews are pulled one by one.
//  3. Cards made here are added to Anki (deck "Medicus" by default), edits made
//     here are sent back, and reviews made here are written into Anki's history.
//  4. Cards whose schedule changed here (reviewed here, or a due date set here)
//     get the same due date in Anki.
//  5. Anki desktop syncs with AnkiWeb again, so the phone gets all of it.
//
// Medicus keeps the full review history from both sides and schedules with FSRS.
// Cards reviewed on the phone keep the phone's schedule there.

export interface SyncReport {
	startedAt: number;
	finishedAt: number | null;
	ok: boolean;
	error: string | null;
	warnings: string[];
	decksRead: string[];
	notesAdded: number;
	notesUpdated: number;
	reviewsPulled: number;
	cardsPushed: number;
	editsPushed: number;
	reviewsPushed: number;
	dueDatesSet: number;
	/** Cards suspended or unsuspended here (by hand or by a linked book) and sent to Anki. */
	suspensionsPushed?: number;
	removed: number;
	ankiWeb: 'synced' | 'skipped' | 'failed';
}

const state = { running: false, step: '', report: null as SyncReport | null };

export function syncState() {
	return { running: state.running, step: state.step, last: state.report ?? kvGet<SyncReport | null>('anki_sync_last', null) };
}

export function syncDecks() {
	return db().select().from(ankiSyncDeck).orderBy(ankiSyncDeck.deck).all();
}

/** Which top-level Anki decks to sync (others are kept but switched off). */
export function setSyncDecks(names: string[]) {
	const want = new Set(names.map((n) => n.trim()).filter(Boolean).slice(0, 50));
	const now = Date.now();
	inTx(() => {
		for (const row of syncDecks()) {
			if (row.enabled !== want.has(row.deck)) db().update(ankiSyncDeck).set({ enabled: want.has(row.deck), updatedAt: now }).where(eq(ankiSyncDeck.deck, row.deck)).run();
			want.delete(row.deck);
		}
		for (const deck of want) db().insert(ankiSyncDeck).values({ deck, enabled: true, createdAt: now, updatedAt: now }).run();
	});
}

function ensureDeckRow(deck: string) {
	const now = Date.now();
	db().insert(ankiSyncDeck).values({ deck, enabled: true, createdAt: now, updatedAt: now }).onConflictDoNothing().run();
	return db().select().from(ankiSyncDeck).where(eq(ankiSyncDeck.deck, deck)).get()!;
}

const quote = (deck: string) => `"deck:${deck.replace(/"/g, '\\"')}"`;
const inDeck = (deck: string | null, root: string) => !!deck && (deck === root || deck.startsWith(root + '::'));

function all<T>(q: string, ...p: unknown[]): T[] {
	return sqlite().prepare(q).all(...p) as T[];
}

/** Our cards by their Anki id. */
function cardsByAnkiId(ids: number[]) {
	const out = new Map<number, { id: string; note_id: string; deck: string | null }>();
	for (let i = 0; i < ids.length; i += 500) {
		const chunk = ids.slice(i, i + 500);
		for (const r of all<{ id: string; note_id: string; deck: string | null; anki_card_id: number }>(
			`SELECT id, note_id, deck, anki_card_id FROM card WHERE deleted_at IS NULL AND anki_card_id IN (${chunk.map(() => '?').join(',')})`,
			...chunk
		))
			out.set(r.anki_card_id, r);
	}
	return out;
}

function pushedIds(ids: number[]) {
	const out = new Set<number>();
	for (let i = 0; i < ids.length; i += 500) {
		const chunk = ids.slice(i, i + 500);
		for (const r of all<{ revlog_id: number }>(`SELECT revlog_id FROM anki_push WHERE revlog_id IN (${chunk.map(() => '?').join(',')})`, ...chunk)) out.add(r.revlog_id);
	}
	return out;
}

// ------------------------------------------------------------ pulling

async function needsReadIn(root: string, lastImportAt: number | null, knownIds: Set<number>, ankiIds: number[]): Promise<boolean> {
	if (!lastImportAt) return true;
	if (ankiIds.some((id) => !knownIds.has(id))) return true;
	const days = Math.min(365, Math.max(1, Math.ceil((Date.now() - lastImportAt) / 86_400_000) + 1));
	const edited = (await invoke<number[]>('findNotes', { query: `${quote(root)} edited:${days}` })) ?? [];
	if (!edited.length) return false;
	let mods: { mod: number }[];
	try {
		mods = (await invoke<{ noteId: number; mod: number }[]>('notesModTime', { notes: edited })) ?? [];
	} catch {
		mods = (await invoke<{ mod: number }[]>('notesInfo', { notes: edited.slice(0, 2000) })) ?? [];
	}
	return mods.some((m) => Number(m.mod) * 1000 > lastImportAt - 60_000);
}

async function readIn(root: string, rep: SyncReport) {
	const workDir = path.join(config.paths.tmp, `anki-sync-${uuidv7()}`);
	fs.mkdirSync(workDir, { recursive: true });
	const file = path.join(workDir, 'deck.apkg');
	try {
		const ok = await invoke<boolean>('exportPackage', { deck: root, path: file, includeSched: true }, { timeoutMs: 15 * 60_000 });
		if (!ok || !fs.existsSync(file)) throw new AnkiConnectError(`Anki couldn’t export the deck “${root}”.`);
		const r = await applyPackage(`sync-${uuidv7()}`, file, workDir, { conflicts: {}, conflictDefault: 'keep', useDeckRetention: false });
		rep.notesAdded += r.notesAdded;
		rep.notesUpdated += r.notesUpdated + r.conflictsOverwritten;
		rep.reviewsPulled += r.reviewsImported;
		rep.decksRead.push(root);
	} finally {
		fs.rmSync(workDir, { recursive: true, force: true });
	}
}

/** Reviews made in Anki (desktop or phone) since the last run, merged into each card's history. */
async function pullReviews(root: string, subdecks: string[], since: number, rep: SyncReport): Promise<number> {
	let maxId = since;
	const rows: number[][] = [];
	for (const d of subdecks) {
		const list = (await invoke<number[][]>('cardReviews', { deck: d, startID: since }, { timeoutMs: 60_000 })) ?? [];
		for (const r of list) {
			rows.push(r);
			if (r[0] > maxId) maxId = r[0];
		}
	}
	if (!rows.length) return maxId;
	const pushed = pushedIds(rows.map((r) => r[0]));
	const byAnki = cardsByAnkiId([...new Set(rows.map((r) => r[1]))]);
	const byCard = new Map<string, ImportedReview[]>();
	for (const [id, cid, , ease, , , , time, type] of rows) {
		// Answers only (manual reschedules have ease 0 or type 4/5), and not the ones this app wrote.
		if (pushed.has(id) || !(ease >= 1 && ease <= 4) || !(type >= 0 && type <= 3)) continue;
		const ours = byAnki.get(cid);
		if (!ours) continue;
		(byCard.get(ours.id) ?? byCard.set(ours.id, []).get(ours.id)!).push({ revlogId: id, rating: ease, reviewedAt: id, timeTakenMs: time });
	}
	inTx(() => {
		for (const [cardId, list] of byCard) rep.reviewsPulled += mergeImportedReviews(cardId, list).added;
	});
	void root;
	return maxId;
}

/** Cards deleted in Anki go here too; cards moved to another deck follow. */
async function followRemovals(root: string, ankiIds: Set<number>, rep: SyncReport, isPushDeck: boolean) {
	const linked = all<{ id: string; note_id: string; anki_card_id: number; deck: string | null; origin: string }>(
		`SELECT c.id, c.note_id, c.anki_card_id, c.deck, n.origin FROM card c JOIN note n ON n.id = c.note_id
		 WHERE c.deleted_at IS NULL AND n.deleted_at IS NULL AND c.anki_card_id > 0`
	).filter((c) => (inDeck(c.deck, root) || (isPushDeck && c.origin !== 'anki' && !c.deck)) && !ankiIds.has(c.anki_card_id));
	if (!linked.length) return;
	const info = (await invoke<{ cardId?: number; deckName?: string }[]>('cardsInfo', { cards: linked.map((c) => c.anki_card_id) })) ?? [];
	const alive = new Map(info.filter((i) => i && i.cardId).map((i) => [i.cardId!, i]));
	const { deleteNote } = await import('../cards');
	const goneNotes = new Set<string>();
	inTx(() => {
		for (const c of linked) {
			const i = alive.get(c.anki_card_id);
			if (i?.deckName) {
				// Moved to another deck in Anki (cards made here keep no deck of their own here).
				if (c.origin === 'anki') sqlite().prepare('UPDATE card SET deck = ?, updated_at = ? WHERE id = ?').run(i.deckName, Date.now(), c.id);
			} else if (c.origin === 'anki') goneNotes.add(c.note_id);
			else {
				// A card made here was deleted in Anki: keep it here, and don't send it again.
				sqlite().prepare('UPDATE card SET anki_card_id = NULL WHERE id = ?').run(c.id);
				sqlite().prepare('UPDATE note SET anki_note_id = -1 WHERE id = ?').run(c.note_id);
			}
		}
	});
	for (const noteId of goneNotes) {
		deleteNote(noteId);
		rep.removed++;
	}
}

// ------------------------------------------------------------ pushing

const MODEL_FOR: Record<string, string> = { 'nt-basic': 'Basic', 'nt-basic-reversed': 'Basic (and reversed card)', 'nt-cloze': 'Cloze' };

function htmlFields(typeId: string, fields: Record<string, string>, source: string | null) {
	const r = (s: string | undefined) => renderMarkdown(s ?? '').trim();
	const from = source ? `<div style="font-size: 0.8em; opacity: 0.7; margin-top: 0.75em">From ${source.replace(/</g, '&lt;')}</div>` : '';
	if (typeId === 'nt-cloze') return { Text: r(fields['Text']), 'Back Extra': r(fields['Back Extra']) + from };
	return { Front: r(fields['Front']), Back: r(fields['Back']) + from };
}

/** Cards made here that Anki doesn't have yet. */
async function pushNewNotes(cfg: AnkiConnectConfig, rep: SyncReport) {
	const rows = all<{ id: string; note_type_id: string; fields: string; tags: string; aamc_code: string | null; rev: number; doc_title: string | null; page: number | null }>(
		`SELECT n.id, n.note_type_id, n.fields, n.tags, n.aamc_code, n.rev, d.title AS doc_title, a.page_number AS page
		 FROM note n LEFT JOIN anchor a ON a.id = n.anchor_id LEFT JOIN document d ON d.id = a.document_id
		 WHERE n.deleted_at IS NULL AND n.origin != 'anki' AND n.anki_note_id IS NULL AND n.note_type_id IN ('nt-basic', 'nt-basic-reversed', 'nt-cloze')
		 ORDER BY n.created_at LIMIT 1000`
	);
	if (!rows.length) return;
	// The standard note types must exist in Anki (they do unless renamed).
	let have = new Set<string>();
	try {
		have = new Set(((await invoke<string[]>('modelNames')) ?? []).filter((m) => Object.values(MODEL_FOR).includes(m)));
	} catch {
		have = new Set(Object.values(MODEL_FOR));
	}
	const usable = rows.filter((r) => have.has(MODEL_FOR[r.note_type_id]));
	if (usable.length < rows.length) rep.warnings.push(`${rows.length - usable.length} card(s) weren’t sent: Anki is missing its standard “Basic” or “Cloze” note type.`);
	if (!usable.length) return;
	const deckFor = (r: (typeof rows)[number]) => (r.doc_title ? `${cfg.pushDeck}::${r.doc_title.replace(/::/g, ' ').replace(/"/g, '')}` : cfg.pushDeck);
	for (const d of new Set(usable.map(deckFor))) await invoke('createDeck', { deck: d });
	const payload = usable.map((r) => {
		const fields = JSON.parse(r.fields) as Record<string, string>;
		const tags = [...(JSON.parse(r.tags) as string[]), 'medicus', ...(r.aamc_code ? [`AAMC::${r.aamc_code}`] : [])].map((t) => t.replace(/\s+/g, '_'));
		return {
			deckName: deckFor(r),
			modelName: MODEL_FOR[r.note_type_id],
			fields: htmlFields(r.note_type_id, fields, r.doc_title ? `${r.doc_title}${r.page ? `, p. ${r.page}` : ''}` : null),
			tags,
			options: { allowDuplicate: true }
		};
	});
	let ids: (number | null)[] = [];
	try {
		ids = (await invoke<(number | null)[]>('addNotes', { notes: payload }, { timeoutMs: 120_000 })) ?? [];
	} catch (err) {
		// One bad note can fail the whole batch: add them one at a time instead.
		ids = [];
		for (const p of payload) {
			try {
				ids.push(await invoke<number>('addNote', { note: p }));
			} catch {
				ids.push(null);
			}
		}
		if (ids.some((x) => !x)) rep.warnings.push(`Some cards couldn’t be added to Anki (${(err as Error).message}).`);
	}
	const added = usable.map((r, i) => ({ r, ankiId: ids[i] })).filter((x): x is { r: (typeof usable)[number]; ankiId: number } => !!x.ankiId);
	if (!added.length) return;
	const infos = (await invoke<{ noteId: number; cards: number[] }[]>('notesInfo', { notes: added.map((a) => a.ankiId) })) ?? [];
	const cardIds = infos.flatMap((i) => i.cards ?? []);
	const cardInfo = cardIds.length ? ((await invoke<{ cardId: number; note: number; ord: number }[]>('cardsInfo', { cards: cardIds })) ?? []) : [];
	inTx(() => {
		for (const a of added) {
			sqlite().prepare('UPDATE note SET anki_note_id = ?, anki_pushed_rev = ? WHERE id = ?').run(a.ankiId, a.r.rev, a.r.id);
			for (const ci of cardInfo.filter((c) => c.note === a.ankiId)) {
				sqlite().prepare('UPDATE card SET anki_card_id = ? WHERE note_id = ? AND ord = ? AND deleted_at IS NULL').run(ci.cardId, a.r.id, ci.ord);
			}
			rep.cardsPushed++;
		}
	});
}

/**
 * Image occlusion cards made here go to Anki's own Image Occlusion note type
 * (Anki 23.10 and later), with their picture copied into Anki's media first.
 */
async function pushImageOcclusion(cfg: AnkiConnectConfig, rep: SyncReport) {
	const rows = all<{ id: string; fields: string; tags: string; aamc_code: string | null; rev: number; doc_title: string | null }>(
		`SELECT n.id, n.fields, n.tags, n.aamc_code, n.rev, d.title AS doc_title
		 FROM note n LEFT JOIN anchor a ON a.id = n.anchor_id LEFT JOIN document d ON d.id = a.document_id
		 WHERE n.deleted_at IS NULL AND n.origin != 'anki' AND n.anki_note_id IS NULL AND n.note_type_id = 'nt-image-occlusion'
		 ORDER BY n.created_at LIMIT 300`
	);
	if (!rows.length) return;
	const models = (await invoke<string[]>('modelNames')) ?? [];
	if (!models.includes('Image Occlusion')) {
		rep.warnings.push(`${rows.length} image occlusion card(s) weren’t sent: Anki has no “Image Occlusion” note type (it comes with Anki 23.10 and later).`);
		return;
	}
	const { mediaFile } = await import('./media');
	const deckFor = (r: (typeof rows)[number]) => (r.doc_title ? `${cfg.pushDeck}::${r.doc_title.replace(/::/g, ' ').replace(/"/g, '')}` : cfg.pushDeck);
	for (const d of new Set(rows.map(deckFor))) await invoke('createDeck', { deck: d });
	const added: { r: (typeof rows)[number]; ankiId: number }[] = [];
	for (const r of rows) {
		const fields = JSON.parse(r.fields) as Record<string, string>;
		const img = /<img[^>]*\ssrc\s*=\s*["']?([^"'\s>]+)/i.exec(fields['Image'] ?? '')?.[1];
		const file = img ? mediaFile(decodeURIComponent(img)) : null;
		if (!img || !file) {
			rep.warnings.push('An image occlusion card wasn’t sent: its picture is missing.');
			continue;
		}
		try {
			await invoke('storeMediaFile', { filename: decodeURIComponent(img), path: file.path });
			const tags = [...(JSON.parse(r.tags) as string[]), 'medicus', ...(r.aamc_code ? [`AAMC::${r.aamc_code}`] : [])].map((t) => t.replace(/\s+/g, '_'));
			const ankiId = await invoke<number>('addNote', {
				note: {
					deckName: deckFor(r),
					modelName: 'Image Occlusion',
					fields: { Occlusion: fields['Occlusion'] ?? '', Image: fields['Image'] ?? '', Header: fields['Header'] ?? '', 'Back Extra': fields['Back Extra'] ?? '', Comments: fields['Comments'] ?? '' },
					tags,
					options: { allowDuplicate: true }
				}
			});
			if (ankiId) added.push({ r, ankiId });
		} catch (err) {
			rep.warnings.push(`An image occlusion card couldn’t be added to Anki (${(err as Error).message}).`);
		}
	}
	if (!added.length) return;
	const infos = (await invoke<{ noteId: number; cards: number[] }[]>('notesInfo', { notes: added.map((a) => a.ankiId) })) ?? [];
	const cardIds = infos.flatMap((i) => i.cards ?? []);
	const cardInfo = cardIds.length ? ((await invoke<{ cardId: number; note: number; ord: number }[]>('cardsInfo', { cards: cardIds })) ?? []) : [];
	inTx(() => {
		for (const a of added) {
			sqlite().prepare('UPDATE note SET anki_note_id = ?, anki_pushed_rev = ? WHERE id = ?').run(a.ankiId, a.r.rev, a.r.id);
			for (const ci of cardInfo.filter((c) => c.note === a.ankiId)) {
				sqlite().prepare('UPDATE card SET anki_card_id = ? WHERE note_id = ? AND ord = ? AND deleted_at IS NULL').run(ci.cardId, a.r.id, ci.ord);
			}
			rep.cardsPushed++;
		}
	});
}

/** Edits made here to cards Anki already has. */
async function pushEdits(rep: SyncReport) {
	const own = all<{ id: string; anki_note_id: number; note_type_id: string; fields: string; rev: number; doc_title: string | null; page: number | null }>(
		`SELECT n.id, n.anki_note_id, n.note_type_id, n.fields, n.rev, d.title AS doc_title, a.page_number AS page
		 FROM note n LEFT JOIN anchor a ON a.id = n.anchor_id LEFT JOIN document d ON d.id = a.document_id
		 WHERE n.deleted_at IS NULL AND n.origin != 'anki' AND n.anki_note_id > 0 AND n.rev > coalesce(n.anki_pushed_rev, 0)`
	);
	for (const r of own) {
		// Card types with their own templates (image occlusion) are HTML already: sent as they are.
		const fields =
			r.note_type_id in MODEL_FOR
				? htmlFields(r.note_type_id, JSON.parse(r.fields), r.doc_title ? `${r.doc_title}${r.page ? `, p. ${r.page}` : ''}` : null)
				: (JSON.parse(r.fields) as Record<string, string>);
		await invoke('updateNoteFields', { note: { id: r.anki_note_id, fields } });
		sqlite().prepare('UPDATE note SET anki_pushed_rev = ? WHERE id = ?').run(r.rev, r.id);
		rep.editsPushed++;
	}
	const fromAnki = all<{ id: string; anki_note_id: number; note_type_id: string; fields: string; tags: string; rev: number }>(
		`SELECT id, anki_note_id, note_type_id, fields, tags, rev FROM note
		 WHERE deleted_at IS NULL AND origin = 'anki' AND anki_note_id > 0 AND imported_rev IS NOT NULL AND rev > imported_rev`
	);
	for (const r of fromAnki) {
		const fields = JSON.parse(r.fields) as Record<string, string>;
		await invoke('updateNoteFields', { note: { id: r.anki_note_id, fields } });
		const t = db().select({ fields: noteType.fields }).from(noteType).where(eq(noteType.id, r.note_type_id)).get();
		const values = (t?.fields ?? Object.keys(fields)).map((f) => fields[f] ?? '');
		sqlite().prepare('UPDATE note SET imported_rev = rev, imported_hash = ? WHERE id = ?').run(noteHash(values, JSON.parse(r.tags)), r.id);
		rep.editsPushed++;
	}
}

/** Suspends and unsuspends made here (by hand, or by a book linked to the deck), done in Anki too. */
async function pushSuspensions(rep: SyncReport) {
	const p = pendingAnkiSuspensions();
	if (!p.changeIds.length) return;
	let sent = 0;
	const send = async (action: 'suspend' | 'unsuspend', ids: number[]) => {
		for (let i = 0; i < ids.length; i += 500) {
			const part = ids.slice(i, i + 500);
			try {
				await invoke(action, { cards: part }, { timeoutMs: 60_000 });
				sent += part.length;
			} catch {
				// A card Anki no longer has fails the whole call: send the rest one by one.
				for (const id of part) {
					try {
						await invoke(action, { cards: [id] });
						sent++;
					} catch {
						// gone from Anki: nothing to do
					}
				}
			}
		}
	};
	await send('suspend', p.suspend);
	await send('unsuspend', p.unsuspend);
	markSuspensionsPushed(p.changeIds);
	rep.suspensionsPushed = (rep.suspensionsPushed ?? 0) + sent;
}

/** Reviews made here, written into Anki's review history. Returns the cards they were on. */
async function pushReviews(rep: SyncReport): Promise<string[]> {
	const rows = all<{ id: string; card_id: string; anki_card_id: number; rating: number; reviewed_at: number; time_taken_ms: number; prev_state: number; next_state: number; next_due: number }>(
		`SELECT e.id, e.card_id, c.anki_card_id, e.rating, e.reviewed_at, e.time_taken_ms, e.prev_state, e.next_state, e.next_due
		 FROM review_event e JOIN card c ON c.id = e.card_id
		 WHERE c.anki_card_id > 0 AND c.deleted_at IS NULL AND e.device_id != 'anki'
		 AND NOT EXISTS (SELECT 1 FROM anki_push p WHERE p.event_id = e.id)
		 ORDER BY e.reviewed_at LIMIT 5000`
	);
	if (!rows.length) return [];
	const used = new Set<number>();
	const tuples: number[][] = [];
	const map: { eventId: string; revlogId: number }[] = [];
	const taken = sqlite().prepare('SELECT 1 FROM anki_push WHERE revlog_id = ?');
	for (const r of rows) {
		let rid = r.reviewed_at;
		while (used.has(rid) || taken.get(rid)) rid++;
		used.add(rid);
		const span = r.next_due - r.reviewed_at;
		const ivl = r.next_state === 2 ? Math.max(1, Math.round(span / 86_400_000)) : -Math.max(1, Math.round(span / 1000));
		const type = r.prev_state === 2 ? 1 : r.prev_state === 3 ? 2 : 0;
		tuples.push([rid, r.anki_card_id, -1, r.rating, ivl, 0, 2500, Math.min(60_000, Math.max(0, r.time_taken_ms)), type]);
		map.push({ eventId: r.id, revlogId: rid });
	}
	for (let i = 0; i < tuples.length; i += 500) {
		await invoke('insertReviews', { reviews: tuples.slice(i, i + 500) }, { timeoutMs: 60_000 });
		inTx(() => {
			for (const m of map.slice(i, i + 500)) sqlite().prepare('INSERT OR IGNORE INTO anki_push (event_id, revlog_id, pushed_at) VALUES (?, ?, ?)').run(m.eventId, m.revlogId, Date.now());
		});
	}
	rep.reviewsPushed += tuples.length;
	return [...new Set(rows.map((r) => r.card_id))];
}

/** Gives cards in Anki the due date they have here (reviewed here, or a due date set here). */
async function pushDueDates(cardIds: string[], since: number, rep: SyncReport) {
	const manual = all<{ card_id: string }>(`SELECT DISTINCT card_id FROM card_due_change WHERE source = 'manual' AND changed_at > ?`, since).map((r) => r.card_id);
	const ids = [...new Set([...cardIds, ...manual])];
	if (!ids.length) return;
	const clock = studyClock();
	const groups = new Map<string, number[]>();
	for (let i = 0; i < ids.length; i += 500) {
		const chunk = ids.slice(i, i + 500);
		for (const c of all<{ anki_card_id: number; due: number; state: number }>(
			`SELECT anki_card_id, due, state FROM card WHERE anki_card_id > 0 AND deleted_at IS NULL AND id IN (${chunk.map(() => '?').join(',')})`,
			...chunk
		)) {
			if (c.state === 0) continue;
			const days = c.state === 2 ? Math.max(0, diffDays(clock.today, studyDayFor(c.due))) : 0;
			const spec = c.state === 2 && days > 0 ? `${days}!` : '0';
			(groups.get(spec) ?? groups.set(spec, []).get(spec)!).push(c.anki_card_id);
		}
	}
	for (const [days, cards] of groups) {
		for (let i = 0; i < cards.length; i += 500) {
			await invoke('setDueDate', { cards: cards.slice(i, i + 500), days });
			rep.dueDatesSet += Math.min(500, cards.length - i);
		}
	}
}

// ------------------------------------------------------------ the run

function newReport(): SyncReport {
	return { startedAt: Date.now(), finishedAt: null, ok: false, error: null, warnings: [], decksRead: [], notesAdded: 0, notesUpdated: 0, reviewsPulled: 0, cardsPushed: 0, editsPushed: 0, reviewsPushed: 0, dueDatesSet: 0, removed: 0, ankiWeb: 'skipped' };
}

export class SyncError extends Error {}

/** One full sync. Only one runs at a time. */
export async function runSync(): Promise<SyncReport> {
	if (state.running) throw new SyncError('A sync is already running.');
	if (role() !== 'primary') throw new SyncError('Only the primary device syncs with Anki.');
	const cfg = ankiConnectConfig();
	const rep = newReport();
	const since = kvGet<number>('anki_sync_since', 0);
	state.running = true;
	state.report = rep;
	const step = (s: string) => (state.step = s);
	try {
		step('Connecting to Anki');
		const st = await ankiStatus();
		if (!st.reachable) throw new AnkiConnectError(st.message, 'unreachable');
		if (cfg.ankiWeb) {
			step('Anki is syncing with AnkiWeb (picks up your phone’s reviews)');
			try {
				await invoke('sync', {}, { timeoutMs: 180_000 });
				rep.ankiWeb = 'synced';
			} catch (err) {
				rep.ankiWeb = 'failed';
				rep.warnings.push(`Anki couldn’t sync with AnkiWeb: ${(err as Error).message} Is Anki desktop signed in (the Sync button in Anki)?`);
			}
		}
		const deckNames = (await invoke<string[]>('deckNames')) ?? [];
		const roots = [...new Set([...syncDecks().filter((d) => d.enabled).map((d) => d.deck), ...(cfg.pushOwnCards ? [cfg.pushDeck] : [])])];
		for (const root of roots) {
			if (!deckNames.includes(root)) {
				if (root !== cfg.pushDeck) rep.warnings.push(`Anki has no deck called “${root}” any more.`);
				continue;
			}
			const row = ensureDeckRow(root);
			step(`Checking ${root}`);
			const ankiIds = (await invoke<number[]>('findCards', { query: quote(root) }, { timeoutMs: 60_000 })) ?? [];
			// Any card already linked counts as known, whichever deck it's in here.
			const known = new Set(all<{ a: number }>('SELECT anki_card_id AS a FROM card WHERE deleted_at IS NULL AND anki_card_id > 0').map((c) => c.a));
			const readStarted = Date.now();
			if (await needsReadIn(root, row.lastImportAt, known, ankiIds)) {
				step(`Reading in ${root} (new or changed cards)`);
				await readIn(root, rep);
				db().update(ankiSyncDeck).set({ lastImportAt: readStarted, updatedAt: Date.now() }).where(eq(ankiSyncDeck.deck, root)).run();
			}
			step(`Getting new reviews from ${root}`);
			const subdecks = deckNames.filter((d) => d === root || d.startsWith(root + '::'));
			const maxId = await pullReviews(root, subdecks, row.lastRevlogId, rep);
			if (maxId > row.lastRevlogId) db().update(ankiSyncDeck).set({ lastRevlogId: maxId, updatedAt: Date.now() }).where(eq(ankiSyncDeck.deck, root)).run();
			await followRemovals(root, new Set(ankiIds), rep, root === cfg.pushDeck);
		}
		if (cfg.pushOwnCards) {
			step(`Adding cards made here to Anki (${cfg.pushDeck})`);
			await pushNewNotes(cfg, rep);
			await pushImageOcclusion(cfg, rep);
		}
		step('Sending edits made here');
		await pushEdits(rep);
		step('Sending suspended and unsuspended cards');
		await pushSuspensions(rep);
		step('Sending reviews made here');
		const reviewed = await pushReviews(rep);
		step('Matching due dates');
		await pushDueDates(reviewed, since, rep);
		if (cfg.ankiWeb && rep.ankiWeb === 'synced') {
			step('Anki is syncing with AnkiWeb (sends it all to your phone)');
			try {
				await invoke('sync', {}, { timeoutMs: 180_000 });
			} catch (err) {
				rep.ankiWeb = 'failed';
				rep.warnings.push(`The second AnkiWeb sync didn’t work: ${(err as Error).message}`);
			}
		}
		rep.ok = true;
		kvSet('anki_sync_since', rep.startedAt);
		if (rep.notesAdded || rep.notesUpdated) requestIndex();
	} catch (err) {
		rep.ok = false;
		rep.error = err instanceof Error ? err.message : String(err);
		if (!(err instanceof AnkiConnectError) && !(err instanceof SyncError)) console.error('Anki sync failed:', err);
	} finally {
		rep.finishedAt = Date.now();
		state.running = false;
		state.step = '';
		state.report = rep;
		kvSet('anki_sync_last', rep);
	}
	return rep;
}

/** Called every minute: syncs when it's on, due, and Anki is open. Quiet when Anki is closed. */
export async function autoSync() {
	const cfg = ankiConnectConfig();
	if (!cfg.auto || state.running || role() !== 'primary') return;
	if (!syncDecks().some((d) => d.enabled) && !cfg.pushOwnCards) return;
	if (!kvGet<number>('anki_sync_since', 0) && !syncDecks().length) return; // never set up
	const lastTry = kvGet<number>('anki_sync_try', 0);
	if (Date.now() - lastTry < cfg.autoMinutes * 60_000) return;
	kvSet('anki_sync_try', Date.now());
	const st = await ankiStatus();
	if (!st.reachable) return;
	await runSync();
}
