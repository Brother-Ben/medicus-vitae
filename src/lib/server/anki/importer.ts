import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setImmediate as yieldToServer } from 'node:timers/promises';
import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { notePreview } from '../../cards';
import { requestIndex } from '../ai/indexer';
import { ANKI_DEVICE, indexNote, mergeImportedReviews, type ImportedReview } from '../cards';
import { config } from '../config';
import { db, inTx, sqlite } from '../db';
import { ankiImport, card, note, noteType, user } from '../db/schema';
import { emptyState } from '../fsrs';
import { uuidv7 } from '../ids';
import { registerJobHandler, enqueueJob, type JobContext } from '../jobs';
import { studySettings } from '../settings';
import { hasImageOcclusionCloze } from './cloze';
import { hasScript, mediaReferences, renameMediaReferences } from './html';
import { mediaByName, storeMediaFile } from './media';
import {
	cardsForNotes,
	noteBatches,
	openCollection,
	openPackage,
	PackageError,
	readCollectionInfo,
	reviewsForCards,
	schedulingSummary,
	type AnkiCard,
	type AnkiNote,
	type AnkiNoteType,
	type CollectionInfo,
	type PackageVersion
} from './package';

// Anki import (CARD-02, M3). Two steps:
//  1. analyze: read the package and compare it with what's here; the owner sees
//     a report (what's new, what changed, anything unsupported, any card they
//     edited here that the deck also changed) and decides.
//  2. apply: write notes, cards, media and review history.
// Identity follows Anki: notes by GUID, cards by note GUID + template position,
// review history by Anki's review id. Both steps can be re-run after an
// interruption without duplicating anything.

export class AnkiImportError extends Error {}

export interface NoteSample {
	guid: string;
	preview: string;
}

export interface UnsupportedItem {
	kind: 'script' | 'image_occlusion' | 'type_answer' | 'deck_options' | 'deleted_here' | 'media_missing' | 'empty_notes';
	title: string;
	detail: string;
	count: number;
	notes: NoteSample[];
}

export interface Conflict {
	guid: string;
	noteId: string;
	noteType: string;
	fieldNames: string[];
	local: Record<string, string>;
	incoming: Record<string, string>;
	localTags: string[];
	incomingTags: string[];
}

export interface ImportAnalysis {
	version: PackageVersion;
	schema: number;
	totals: { notes: number; cards: number; reviews: number; media: number };
	noteTypes: { name: string; kind: 'standard' | 'cloze'; notes: number; fields: string[]; scripts: boolean; typeAnswer: boolean; imageOcclusion: boolean }[];
	decks: { name: string; cards: number; preset: string | null }[];
	plan: {
		newNotes: number;
		updatedNotes: number;
		unchangedNotes: number;
		/** Edited here; the deck didn't change them, so they stay as they are. */
		keptLocal: number;
		conflicts: number;
		deletedHere: number;
		/** Always 0 now that image occlusion cards are imported (kept for reports saved earlier). */
		skippedImageOcclusion: number;
		newCards: number;
		existingCards: number;
	};
	history: {
		status: 'included' | 'none' | 'stripped';
		reviews: number;
		alreadyImported: number;
		cardsWithHistory: number;
		notReviews: number;
		message: string;
	};
	media: { files: number; missing: { name: string; notes: number }[]; missingCount: number; notIncluded: boolean };
	/** The deck's tags (they come in with every note; linked books match chapters to them). Absent in older saved reports. */
	tags?: { tagged: number; distinct: number; groups: { name: string; notes: number }[] };
	/** Notes whose cards run the deck's own scripts (they run here as in Anki, inside the card). */
	scriptNotes?: number;
	unsupported: UnsupportedItem[];
	conflicts: Conflict[];
	retention: { deck: number | null; presets: { name: string; desiredRetention: number | null }[]; current: number };
}

export interface ImportDecisions {
	/** Per conflicting note GUID; anything not listed uses `conflictDefault`. */
	conflicts: Record<string, 'keep' | 'overwrite'>;
	conflictDefault: 'keep' | 'overwrite';
	useDeckRetention: boolean;
}

export interface ImportResult {
	notesAdded: number;
	notesUpdated: number;
	notesUnchanged: number;
	conflictsKept: number;
	conflictsOverwritten: number;
	cardsAdded: number;
	reviewsImported: number;
	reviewsAlreadyHere: number;
	mediaAdded: number;
	mediaRenamed: number;
	retentionChangedTo: number | null;
}

const SAMPLE_LIMIT = 100;
const CONFLICT_LIMIT = 300;

export function importWorkDir(id: string) {
	return path.join(config.paths.tmp, `anki-${id}`);
}

export function packagePath(id: string) {
	return path.join(importWorkDir(id), 'package.zip');
}

function fieldsRecord(type: AnkiNoteType, values: string[]) {
	const out: Record<string, string> = {};
	type.fields.forEach((name, i) => (out[name] = values[i] ?? ''));
	return out;
}

/** Fingerprint of a note as the deck had it: fields in order plus tags. */
export function noteHash(values: string[], tags: string[]) {
	return createHash('sha256')
		.update(JSON.stringify([values, [...tags].sort()]))
		.digest('hex');
}

function isImageOcclusionNote(type: AnkiNoteType, values: string[]) {
	if (type.stockImageOcclusion || /image occlusion/i.test(type.name)) return true;
	if (type.fields.some((f) => /^(question|answer|original) mask$/i.test(f))) return true;
	return values.some((v) => hasImageOcclusionCloze(v));
}

function deckNameFor(info: CollectionInfo, c: AnkiCard) {
	// Cards in a filtered deck belong to their home deck.
	const home = c.odid ? info.decks.get(c.odid) : info.decks.get(c.did);
	return home?.name ?? info.decks.get(c.did)?.name ?? null;
}

function usableReview(r: { ease: number; type: number }) {
	// 0 learn, 1 review, 2 relearn, 3 filtered; 4/5 are manual reschedules (not answers). Ease 0 = manual.
	return r.ease >= 1 && r.ease <= 4 && r.type >= 0 && r.type <= 3;
}

interface LocalNote {
	id: string;
	guid: string;
	rev: number;
	imported_rev: number | null;
	imported_hash: string | null;
	note_type_id: string;
	fields: string;
	tags: string;
	deleted_at: number | null;
	origin: string;
}

function localNotesByGuid(guids: string[]): Map<string, LocalNote> {
	const out = new Map<string, LocalNote>();
	for (let i = 0; i < guids.length; i += 500) {
		const chunk = guids.slice(i, i + 500);
		const rows = sqlite()
			.prepare(
				`SELECT id, guid, rev, imported_rev, imported_hash, note_type_id, fields, tags, deleted_at, origin FROM note
				 WHERE guid IN (${chunk.map(() => '?').join(',')})`
			)
			.all(...chunk) as LocalNote[];
		for (const r of rows) out.set(r.guid, r);
	}
	return out;
}

/** Notes here that came from (or were sent to) these Anki note ids (Anki sync). */
function localNotesByAnkiId(ids: number[]): Map<number, LocalNote> {
	const out = new Map<number, LocalNote>();
	for (let i = 0; i < ids.length; i += 500) {
		const chunk = ids.slice(i, i + 500);
		const rows = sqlite()
			.prepare(
				`SELECT id, guid, rev, imported_rev, imported_hash, note_type_id, fields, tags, deleted_at, origin, anki_note_id FROM note
				 WHERE anki_note_id IN (${chunk.map(() => '?').join(',')})`
			)
			.all(...chunk) as (LocalNote & { anki_note_id: number })[];
		for (const r of rows) out.set(r.anki_note_id, r);
	}
	return out;
}

/** Anki review ids that are really reviews made here and written into Anki by the sync. */
function pushedRevlogIds(ids: number[]): Set<number> {
	const out = new Set<number>();
	for (let i = 0; i < ids.length; i += 500) {
		const chunk = ids.slice(i, i + 500);
		for (const r of sqlite().prepare(`SELECT revlog_id FROM anki_push WHERE revlog_id IN (${chunk.map(() => '?').join(',')})`).all(...chunk) as { revlog_id: number }[]) out.add(r.revlog_id);
	}
	return out;
}

function addSample(item: UnsupportedItem, sample: NoteSample) {
	item.count++;
	if (item.notes.length < SAMPLE_LIMIT) item.notes.push(sample);
}

// ------------------------------------------------------------- analysis

export async function analyzePackage(file: string, workDir: string, onProgress: (f: number, m: string) => void = () => {}): Promise<ImportAnalysis> {
	const pkg = await openPackage(file, workDir);
	let col: Database.Database | null = null;
	try {
		col = openCollection(pkg.collectionPath);
		const info = readCollectionInfo(col);
		if (!info.noteCount) throw new AnkiImportError('This package has no notes in it.');
		onProgress(0.05, `Reading ${info.noteCount} notes`);

		const typeStats = new Map<number, ImportAnalysis['noteTypes'][number]>();
		const deckCards = new Map<string, { cards: number; preset: string | null }>();
		const plan: ImportAnalysis['plan'] = {
			newNotes: 0,
			updatedNotes: 0,
			unchangedNotes: 0,
			keptLocal: 0,
			conflicts: 0,
			deletedHere: 0,
			skippedImageOcclusion: 0,
			newCards: 0,
			existingCards: 0
		};
		// Scripts aren't a problem (they run inside each card, as in Anki), so they're
		// counted for the report rather than listed as unsupported.
		let scriptNotes = 0;
		let taggedNotes = 0;
		const distinctTags = new Set<string>();
		const tagGroups = new Map<string, { name: string; notes: number }>();
		const unsupported = {
			io: {
				kind: 'image_occlusion',
				title: 'Image occlusion masks can’t be edited here',
				detail:
					'These cards show their picture with the masks, as in Anki, and you can study them here. Drawing or moving masks needs Anki: change them there and import the deck again.',
				count: 0,
				notes: []
			} as UnsupportedItem,
			typeAnswer: {
				kind: 'type_answer',
				title: 'Typed answers shown instead of typed',
				detail: 'These cards ask you to type the answer in Anki. Here the expected answer is shown when you reveal the card.',
				count: 0,
				notes: []
			} as UnsupportedItem,
			deleted: {
				kind: 'deleted_here',
				title: 'Notes you deleted here stay deleted',
				detail: 'You deleted these notes in Medicus Vitae, so the import doesn’t bring them back.',
				count: 0,
				notes: []
			} as UnsupportedItem,
			empty: {
				kind: 'empty_notes',
				title: 'Notes with no cards skipped',
				detail: 'These notes have no cards in the package.',
				count: 0,
				notes: []
			} as UnsupportedItem
		};
		const missingMedia = new Map<string, number>();
		const packageMedia = new Set(pkg.media.map((m) => m.name));
		const conflicts: Conflict[] = [];
		let cardsWithHistory = 0;
		let usableReviews = 0;
		let notReviews = 0;
		let alreadyImported = 0;
		let done = 0;
		const reviewExists = sqlite().prepare('SELECT 1 FROM review_event WHERE device_id = ? AND device_seq = ?');

		for (const batch of noteBatches(col)) {
			const locals = localNotesByGuid(batch.map((n) => n.guid));
			const cards = cardsForNotes(col, batch.map((n) => n.id));
			const cardsByNote = new Map<number, AnkiCard[]>();
			for (const c of cards) (cardsByNote.get(c.nid) ?? cardsByNote.set(c.nid, []).get(c.nid)!).push(c);
			const reviews = reviewsForCards(col, cards.map((c) => c.id));
			const reviewsByCard = new Map<number, number>();
			for (const r of reviews) {
				if (!usableReview(r)) {
					notReviews++;
					continue;
				}
				usableReviews++;
				reviewsByCard.set(r.cid, (reviewsByCard.get(r.cid) ?? 0) + 1);
				if (reviewExists.get(ANKI_DEVICE, r.id)) alreadyImported++;
			}

			for (const n of batch) {
				const type = info.noteTypes.get(n.mid);
				if (!type) continue;
				const stat =
					typeStats.get(n.mid) ??
					typeStats
						.set(n.mid, {
							name: type.name,
							kind: type.kind,
							notes: 0,
							fields: type.fields,
							scripts: type.templates.some((t) => hasScript(t.front + t.back)),
							typeAnswer: type.templates.some((t) => /\{\{[^}]*type:/.test(t.front + t.back)),
							imageOcclusion: false
						})
						.get(n.mid)!;
				stat.notes++;
				const sample = () => ({ guid: n.guid, preview: notePreview('anki', fieldsRecord(type, n.fields), 120) || '(empty note)' });
				const noteCards = cardsByNote.get(n.id) ?? [];

				if (isImageOcclusionNote(type, n.fields)) {
					stat.imageOcclusion = true;
					addSample(unsupported.io, sample());
				}
				if (!noteCards.length) {
					addSample(unsupported.empty, sample());
					continue;
				}
				if (stat.scripts || n.fields.some((f) => hasScript(f))) scriptNotes++;
				if (n.tags.length) {
					taggedNotes++;
					// Groups: the first two levels ("#AK_MCAT_v2::#Kaplan"), each counted once per note.
					const groups = new Set<string>();
					for (const t of n.tags) {
						if (distinctTags.size < 200_000) distinctTags.add(t.toLowerCase());
						groups.add(t.split('::').slice(0, 2).join('::'));
					}
					for (const g of groups) {
						const key = g.toLowerCase();
						const e = tagGroups.get(key) ?? tagGroups.set(key, { name: g, notes: 0 }).get(key)!;
						e.notes++;
					}
				}
				if (stat.typeAnswer) addSample(unsupported.typeAnswer, sample());
				for (const v of n.fields) {
					for (const ref of mediaReferences(v)) {
						if (!packageMedia.has(ref) && !mediaByName(ref)) missingMedia.set(ref, (missingMedia.get(ref) ?? 0) + 1);
					}
				}
				for (const c of noteCards) {
					const deck = deckNameFor(info, c) ?? 'Default';
					const d = deckCards.get(deck) ?? deckCards.set(deck, { cards: 0, preset: null }).get(deck)!;
					d.cards++;
					const home = info.decks.get(c.odid || c.did);
					if (home?.configId != null) d.preset = info.deckConfigs.get(home.configId)?.name ?? d.preset;
					if (reviewsByCard.get(c.id)) cardsWithHistory++;
				}

				const local = locals.get(n.guid);
				const hash = noteHash(n.fields, n.tags);
				if (!local) {
					plan.newNotes++;
					plan.newCards += noteCards.length;
					continue;
				}
				if (local.deleted_at) {
					plan.deletedHere++;
					addSample(unsupported.deleted, sample());
					continue;
				}
				const haveOrds = new Set(
					(sqlite().prepare('SELECT ord FROM card WHERE note_id = ? AND deleted_at IS NULL').all(local.id) as { ord: number }[]).map((r) => r.ord)
				);
				for (const c of noteCards) {
					if (haveOrds.has(c.ord)) plan.existingCards++;
					else plan.newCards++;
				}
				const editedHere = local.imported_rev === null ? local.origin !== 'anki' || local.rev > 1 : local.rev > local.imported_rev;
				if (local.imported_hash === hash) {
					if (editedHere) plan.keptLocal++;
					else plan.unchangedNotes++;
				} else if (!editedHere) {
					plan.updatedNotes++;
				} else {
					plan.conflicts++;
					if (conflicts.length < CONFLICT_LIMIT) {
						const localFields = JSON.parse(local.fields) as Record<string, string>;
						conflicts.push({
							guid: n.guid,
							noteId: local.id,
							noteType: type.name,
							fieldNames: type.fields,
							local: localFields,
							incoming: fieldsRecord(type, n.fields),
							localTags: JSON.parse(local.tags) as string[],
							incomingTags: n.tags
						});
					}
				}
			}
			done += batch.length;
			onProgress(0.05 + 0.9 * (done / info.noteCount), `Checked ${done} of ${info.noteCount} notes`);
			await yieldToServer();
		}

		const sched = schedulingSummary(col);
		let history: ImportAnalysis['history'];
		if (info.revlogCount === 0) {
			const stripped = (sched.studied ?? 0) > 0;
			history = {
				status: stripped ? 'stripped' : 'none',
				reviews: 0,
				alreadyImported: 0,
				cardsWithHistory: 0,
				notReviews: 0,
				message: stripped
					? 'This package has study progress on its cards but no review history, so the cards start as new here. No history was made up to fill the gap.'
					: 'This package has no review history (it was exported without scheduling information, or never studied). Cards start as new; no history was made up.'
			};
		} else {
			history = {
				status: 'included',
				reviews: usableReviews,
				alreadyImported,
				cardsWithHistory,
				notReviews,
				message:
					`${usableReviews.toLocaleString('en-US')} past reviews for ${cardsWithHistory.toLocaleString('en-US')} cards come with this deck` +
					(alreadyImported ? ` (${alreadyImported.toLocaleString('en-US')} were imported before and won’t be counted twice)` : '') +
					'. Each card’s schedule is recomputed from its history with FSRS, so due dates can differ from Anki’s if your deck settings differ.'
			};
		}

		// Deck options: only desired retention carries over (and only if the owner says so).
		const presetIds = new Set<number>();
		for (const d of info.decks.values()) if (d.configId != null && [...deckCards.keys()].includes(d.name)) presetIds.add(d.configId);
		const presets = [...presetIds].map((id) => info.deckConfigs.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
		const retentions = presets.map((p) => p.desiredRetention).filter((r): r is number => typeof r === 'number' && r >= 0.7 && r <= 0.99);
		const deckRetention = retentions.length ? Math.round((retentions.reduce((a, b) => a + b, 0) / retentions.length) * 100) / 100 : null;
		const unsupportedList: UnsupportedItem[] = [];
		if (presets.length) {
			unsupportedList.push({
				kind: 'deck_options',
				title: 'Deck options not imported',
				detail: `The deck preset${presets.length > 1 ? 's' : ''} ${presets.map((p) => `“${p.name}”`).join(', ')} also set${presets.length > 1 ? '' : 's'} daily limits, learning steps, burying and other options. Medicus Vitae uses your own study settings for those${deckRetention ? '; desired retention can be carried over below' : ''}.`,
				count: presets.length,
				notes: []
			});
		}
		if (missingMedia.size) {
			unsupportedList.push({
				kind: 'media_missing',
				title: 'Images or sounds missing from the package',
				detail: pkg.media.length
					? 'Some notes refer to media files that aren’t in the package. Those images or sounds won’t show.'
					: 'The package was exported without media, so images and sounds in these notes won’t show. Export again from Anki with “Include media” checked to bring them in.',
				count: missingMedia.size,
				notes: []
			});
		}
		for (const item of [unsupported.io, unsupported.typeAnswer, unsupported.deleted, unsupported.empty]) {
			if (item.count) unsupportedList.push(item);
		}

		onProgress(1, 'Ready to import');
		return {
			version: pkg.version,
			schema: info.schema,
			totals: { notes: info.noteCount, cards: info.cardCount, reviews: usableReviews, media: pkg.media.length },
			noteTypes: [...typeStats.values()].sort((a, b) => b.notes - a.notes),
			decks: [...deckCards.entries()].map(([name, v]) => ({ name, ...v })).sort((a, b) => a.name.localeCompare(b.name)),
			plan,
			history,
			media: {
				files: pkg.media.length,
				missing: [...missingMedia.entries()]
					.sort((a, b) => b[1] - a[1])
					.slice(0, 50)
					.map(([name, notes]) => ({ name, notes })),
				missingCount: missingMedia.size,
				notIncluded: pkg.media.length === 0 && missingMedia.size > 0
			},
			tags: {
				tagged: taggedNotes,
				distinct: distinctTags.size,
				groups: [...tagGroups.values()].sort((a, b) => b.notes - a.notes || a.name.localeCompare(b.name)).slice(0, 12)
			},
			scriptNotes,
			unsupported: unsupportedList,
			conflicts,
			retention: {
				deck: deckRetention,
				presets: presets.map((p) => ({ name: p.name, desiredRetention: p.desiredRetention })),
				current: studySettings().desiredRetention
			}
		};
	} finally {
		col?.close();
		pkg.close();
	}
}

// ----------------------------------------------------------------- apply

/**
 * Our id for an Anki note type. Two decks can share a note type id (same author)
 * with different fields; then the second one is kept as a note type of its own,
 * so the first deck's notes keep the fields and templates they were made with.
 */
function noteTypeIdFor(t: AnkiNoteType): string {
	const base = `anki-${t.id}`;
	const existing = db().select({ fields: noteType.fields }).from(noteType).where(eq(noteType.id, base)).get();
	if (!existing || JSON.stringify(existing.fields) === JSON.stringify(t.fields)) return base;
	return `${base}-${createHash('sha256').update(JSON.stringify(t.fields)).digest('hex').slice(0, 8)}`;
}

function upsertNoteType(t: AnkiNoteType, now: number) {
	const id = noteTypeIdFor(t);
	const values = {
		name: t.name,
		kind: t.kind === 'cloze' ? 'anki_cloze' : 'anki_standard',
		fields: t.fields,
		templates: t.templates,
		css: t.css,
		source: 'anki',
		sortField: t.sortField,
		updatedAt: now
	};
	db()
		.insert(noteType)
		.values({ id, ...values, builtin: false, createdAt: now })
		.onConflictDoUpdate({ target: noteType.id, set: values })
		.run();
	return id;
}

function plausibleTime(ms: number, fallback: number) {
	return ms > 946_684_800_000 && ms < fallback + 86_400_000 ? ms : fallback;
}

export async function applyPackage(
	importId: string,
	file: string,
	workDir: string,
	decisions: ImportDecisions,
	onProgress: (f: number, m: string) => void = () => {}
): Promise<ImportResult> {
	const pkg = await openPackage(file, workDir);
	let col: Database.Database | null = null;
	const result: ImportResult = {
		notesAdded: 0,
		notesUpdated: 0,
		notesUnchanged: 0,
		conflictsKept: 0,
		conflictsOverwritten: 0,
		cardsAdded: 0,
		reviewsImported: 0,
		reviewsAlreadyHere: 0,
		mediaAdded: 0,
		mediaRenamed: 0,
		retentionChangedTo: null
	};
	try {
		col = openCollection(pkg.collectionPath);
		const info = readCollectionInfo(col);
		const now = Date.now();

		// 1. Media, so notes can be pointed at renamed files before they're saved.
		const renames = new Map<string, string>();
		const mediaTmp = path.join(workDir, 'media');
		fs.mkdirSync(mediaTmp, { recursive: true });
		for (let i = 0; i < pkg.media.length; i++) {
			const m = pkg.media[i];
			const tmp = path.join(mediaTmp, `m-${i}`);
			await pkg.extractMedia(m, tmp);
			const stored = await storeMediaFile(tmp, m.name);
			if (stored.added) result.mediaAdded++;
			if (stored.name !== m.name) {
				renames.set(m.name, stored.name);
				result.mediaRenamed++;
			}
			if (i % 25 === 0) onProgress(0.3 * ((i + 1) / pkg.media.length), `Copied ${i + 1} of ${pkg.media.length} media files`);
		}
		fs.rmSync(mediaTmp, { recursive: true, force: true });

		// 2. Note types in use.
		const typeIds = new Map<number, string>();
		for (const t of info.noteTypes.values()) typeIds.set(t.id, upsertNoteType(t, now));

		// 3. Notes and cards, a batch at a time.
		let done = 0;
		for (const batch of noteBatches(col, 500)) {
			const locals = localNotesByGuid(batch.map((n) => n.guid));
			const byAnkiId = localNotesByAnkiId(batch.map((n) => n.id));
			const cards = cardsForNotes(col, batch.map((n) => n.id));
			const cardsByNote = new Map<number, AnkiCard[]>();
			for (const c of cards) (cardsByNote.get(c.nid) ?? cardsByNote.set(c.nid, []).get(c.nid)!).push(c);
			const ourCardId = new Map<number, string>();

			inTx(() => {
				for (const n of batch) {
					const type = info.noteTypes.get(n.mid);
					const noteCards = cardsByNote.get(n.id) ?? [];
					if (!type || !noteCards.length) continue;
					// Notes from Anki are known by GUID. Only cards made here and sent to Anki by the sync
					// (which got a new GUID there) are found by their Anki note id; ids can repeat across decks.
					const byId = byAnkiId.get(n.id);
					const sent = byId && byId.origin !== 'anki' ? byId : undefined;
					const local = locals.get(n.guid) ?? sent;
					if (local?.deleted_at) continue;
					const hash = noteHash(n.fields, n.tags);
					const values = n.fields.map((v) => renameMediaReferences(v, renames));
					const fields = fieldsRecord(type, values);
					const typeId = typeIds.get(n.mid)!;
					const createdAt = plausibleTime(n.id, now);
					let noteId: string;

					if (local && local.origin !== 'anki' && sent && sent.id === local.id) {
						// A card made here and sent to Anki by the sync: this app keeps its content
						// (written in Markdown here); only its cards and their reviews are matched up.
						noteId = local.id;
						result.notesUnchanged++;
					} else if (!local) {
						noteId = uuidv7();
						db()
							.insert(note)
							.values({
								id: noteId,
								noteTypeId: typeId,
								fields,
								format: 'html',
								tags: n.tags,
								guid: n.guid,
								origin: 'anki',
								rev: 1,
								importedRev: 1,
								importedHash: hash,
								importId,
								createdAt,
								updatedAt: now
							})
							.run();
						indexNote(noteId, 'anki', fields, null);
						result.notesAdded++;
					} else {
						noteId = local.id;
						const editedHere = local.imported_rev === null ? local.origin !== 'anki' || local.rev > 1 : local.rev > local.imported_rev;
						if (local.imported_hash === hash) {
							result.notesUnchanged++;
						} else if (editedHere && (decisions.conflicts[n.guid] ?? decisions.conflictDefault) !== 'overwrite') {
							// Keep the owner's version, but remember this deck version so it isn't asked again.
							db().update(note).set({ importedHash: hash, importId }).where(eq(note.id, noteId)).run();
							result.conflictsKept++;
						} else {
							const rev = local.rev + 1;
							db()
								.update(note)
								.set({
									noteTypeId: typeId,
									fields,
									format: 'html',
									tags: n.tags,
									rev,
									importedRev: rev,
									importedHash: hash,
									importId,
									updatedAt: now
								})
								.where(eq(note.id, noteId))
								.run();
							indexNote(noteId, 'anki', fields, null);
							if (editedHere) result.conflictsOverwritten++;
							else result.notesUpdated++;
						}
					}
					// Remember the note's id in Anki (the sync uses it to find it again).
					sqlite().prepare('UPDATE note SET anki_note_id = ? WHERE id = ? AND (anki_note_id IS NULL OR anki_note_id <> ?)').run(n.id, noteId, n.id);

					const existing = sqlite().prepare('SELECT id, ord, deck, state, position, anki_card_id FROM card WHERE note_id = ? AND deleted_at IS NULL').all(noteId) as {
						id: string;
						ord: number;
						deck: string | null;
						state: number;
						position: number | null;
						anki_card_id: number | null;
					}[];
					const byOrd = new Map(existing.map((c) => [c.ord, c]));
					// Cards deleted here (a deleted deck) stay deleted when the deck is read in again.
					const deletedOrds = new Set(
						(sqlite().prepare('SELECT ord FROM card WHERE note_id = ? AND deleted_at IS NOT NULL').all(noteId) as { ord: number }[]).map((r) => r.ord)
					);
					for (const c of noteCards) {
						const deck = deckNameFor(info, c);
						// A new card's place in the deck's order (Anki keeps it in `due`).
						const position = c.type === 0 ? c.due : null;
						const have = byOrd.get(c.ord);
						if (!have && deletedOrds.has(c.ord)) continue;
						if (have) {
							const patch: Partial<typeof card.$inferInsert> = {};
							if (have.deck !== deck) patch.deck = deck;
							if (have.anki_card_id !== c.id) patch.ankiCardId = c.id;
							// Still new here and in the deck: follow the deck's (possibly reordered) position.
							if (have.state === 0 && position !== null && have.position !== position) patch.position = position;
							if (Object.keys(patch).length) db().update(card).set(patch).where(eq(card.id, have.id)).run();
							ourCardId.set(c.id, have.id);
							continue;
						}
						const id = uuidv7();
						db()
							.insert(card)
							.values({
								id,
								noteId,
								ord: c.ord,
								...emptyState(createdAt),
								rev: 0,
								deck,
								position,
								ankiCardId: c.id,
								// Suspended in Anki stays suspended; buried cards come back (burying is only for a day).
								suspended: c.queue === -1,
								createdAt,
								updatedAt: now
							})
							.run();
						byOrd.set(c.ord, { id, ord: c.ord, deck, state: 0, position, anki_card_id: c.id });
						ourCardId.set(c.id, id);
						result.cardsAdded++;
					}
				}
			});

			// 4. Review history for this batch's cards.
			const reviews = reviewsForCards(col, [...ourCardId.keys()]);
			// Reviews made here that the sync wrote into Anki are already here as themselves.
			const pushed = pushedRevlogIds(reviews.map((r) => r.id));
			const byCard = new Map<number, ImportedReview[]>();
			for (const r of reviews) {
				if (!usableReview(r) || pushed.has(r.id)) continue;
				(byCard.get(r.cid) ?? byCard.set(r.cid, []).get(r.cid)!).push({
					revlogId: r.id,
					rating: r.ease,
					reviewedAt: r.id,
					timeTakenMs: r.time
				});
			}
			if (byCard.size) {
				inTx(() => {
					for (const [cid, list] of byCard) {
						const target = ourCardId.get(cid);
						if (!target) continue;
						const r = mergeImportedReviews(target, list);
						result.reviewsImported += r.added;
						result.reviewsAlreadyHere += r.duplicate;
					}
				});
			}
			done += batch.length;
			onProgress(0.3 + 0.68 * (done / Math.max(1, info.noteCount)), `Imported ${done} of ${info.noteCount} notes`);
			await yieldToServer();
		}

		if (decisions.useDeckRetention) {
			const analysis = db().select().from(ankiImport).where(eq(ankiImport.id, importId)).get()?.analysis as ImportAnalysis | undefined;
			const r = analysis?.retention.deck;
			if (r && r >= 0.7 && r <= 0.99) {
				db().update(user).set({ desiredRetention: r, updatedAt: Date.now() }).where(eq(user.id, 1)).run();
				result.retentionChangedTo = r;
			}
		}
		onProgress(1, 'Done');
		return result;
	} finally {
		col?.close();
		pkg.close();
	}
}

// ------------------------------------------------------------- the flow

export type ImportRow = typeof ankiImport.$inferSelect;

export function getImport(id: string): ImportRow | null {
	return db().select().from(ankiImport).where(eq(ankiImport.id, id)).get() ?? null;
}

export function listImports(limit = 20): ImportRow[] {
	return sqlite()
		.prepare('SELECT * FROM anki_import ORDER BY created_at DESC LIMIT ?')
		.all(limit)
		.map((r) => mapRow(r as Record<string, unknown>));
}

function mapRow(r: Record<string, unknown>): ImportRow {
	const json = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : (v ?? null));
	return {
		id: String(r.id),
		fileName: String(r.file_name),
		fileSize: Number(r.file_size),
		fileHash: String(r.file_hash),
		status: String(r.status),
		progress: Number(r.progress),
		message: String(r.message ?? ''),
		analysis: json(r.analysis),
		decisions: json(r.decisions),
		result: json(r.result),
		error: (r.error as string | null) ?? null,
		createdAt: Number(r.created_at),
		updatedAt: Number(r.updated_at),
		finishedAt: (r.finished_at as number | null) ?? null
	};
}

function setImport(id: string, values: Partial<typeof ankiImport.$inferInsert>) {
	db()
		.update(ankiImport)
		.set({ ...values, updatedAt: Date.now() })
		.where(eq(ankiImport.id, id))
		.run();
}

/** Registers an uploaded package (already moved to its work folder) and starts the analysis. */
export function startImport(input: { id: string; fileName: string; fileSize: number; fileHash: string }) {
	const now = Date.now();
	db()
		.insert(ankiImport)
		.values({ ...input, status: 'analyzing', progress: 0, message: 'Waiting to start', createdAt: now, updatedAt: now })
		.run();
	enqueueJob('anki_analyze', { importId: input.id });
}

export function confirmImport(id: string, decisions: ImportDecisions) {
	const row = getImport(id);
	if (!row) throw new AnkiImportError('That import no longer exists.');
	if (row.status !== 'ready') throw new AnkiImportError('This import isn’t waiting for confirmation.');
	if (!fs.existsSync(packagePath(id))) throw new AnkiImportError('The uploaded package is gone (it may have been cleaned up). Upload it again.');
	setImport(id, { status: 'importing', decisions, progress: 0, message: 'Starting' });
	enqueueJob('anki_apply', { importId: id });
}

export function cancelImport(id: string) {
	const row = getImport(id);
	if (!row || !['ready', 'failed', 'analyzing'].includes(row.status)) return false;
	setImport(id, { status: 'cancelled', finishedAt: Date.now(), message: '' });
	fs.rmSync(importWorkDir(id), { recursive: true, force: true });
	return true;
}

/** Work folders of imports still in progress (kept when old temporary files are cleaned). */
export function activeImportDirs(): string[] {
	return (
		sqlite().prepare(`SELECT id FROM anki_import WHERE status IN ('analyzing', 'ready', 'importing')`).all() as { id: string }[]
	).map((r) => importWorkDir(r.id));
}

function progressReporter(id: string, ctx: JobContext) {
	let last = 0;
	return (fraction: number, message: string) => {
		ctx.progress(fraction, message);
		const t = Date.now();
		if (t - last < 500 && fraction < 1) return;
		last = t;
		setImport(id, { progress: fraction, message });
	};
}

function failure(err: unknown) {
	if (err instanceof PackageError || err instanceof AnkiImportError) return err.message;
	console.error('Anki import failed:', err);
	return `The import stopped because of an error: ${err instanceof Error ? err.message : String(err)}`;
}

registerJobHandler('anki_analyze', async (row, ctx) => {
	const id = String(row.payload.importId);
	const imp = getImport(id);
	if (!imp || imp.status !== 'analyzing') return;
	try {
		const analysis = await analyzePackage(packagePath(id), importWorkDir(id), progressReporter(id, ctx));
		setImport(id, { status: 'ready', analysis, progress: 1, message: 'Ready to import' });
	} catch (err) {
		if (ctx.signal.aborted) throw err;
		setImport(id, { status: 'failed', error: failure(err), finishedAt: Date.now() });
		fs.rmSync(importWorkDir(id), { recursive: true, force: true });
	}
});

registerJobHandler('anki_apply', async (row, ctx) => {
	const id = String(row.payload.importId);
	const imp = getImport(id);
	if (!imp || imp.status !== 'importing') return;
	const decisions = (imp.decisions as ImportDecisions | null) ?? { conflicts: {}, conflictDefault: 'keep', useDeckRetention: false };
	try {
		const result = await applyPackage(id, packagePath(id), importWorkDir(id), decisions, progressReporter(id, ctx));
		setImport(id, { status: 'done', result, progress: 1, message: 'Done', finishedAt: Date.now() });
		fs.rmSync(importWorkDir(id), { recursive: true, force: true });
		// The imported cards become searchable for the tutor.
		requestIndex();
	} catch (err) {
		if (ctx.signal.aborted) throw err;
		setImport(id, { status: 'failed', error: failure(err), finishedAt: Date.now() });
	}
});
