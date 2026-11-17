// Main database schema (data/cortex.sqlite). Everything the owner creates lives
// here and travels in snapshots and exports. Host-local state (sign-in
// sessions, peer settings) is in data/local.sqlite instead (see local.ts).
//
// Conventions: ids are UUIDv7 text; times are integer milliseconds (UTC);
// study days are 'YYYY-MM-DD' strings computed with the owner's day-start hour.

import { sql } from 'drizzle-orm';
import { index, integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** One row. Identity of this installation and its primary/standby generation (Section 11). */
export const instance = sqliteTable('instance', {
	id: integer('id').primaryKey(),
	installationId: text('installation_id').notNull(),
	/** Raised by one each time a device is made primary. */
	generation: integer('generation').notNull().default(1),
	primaryHostId: text('primary_host_id').notNull(),
	promotedAt: integer('promoted_at').notNull(),
	/** What the current primary started from: { hostId, snapshotId, writeSeq, generation }. */
	promotedFrom: text('promoted_from', { mode: 'json' }).$type<PromotedFrom | null>(),
	/** Shared secret two devices use to pull snapshots from each other. */
	peerKey: text('peer_key').notNull(),
	/** Bumped by triggers on every change to owner data (see the write_seq migration). */
	writeSeq: integer('write_seq').notNull().default(0),
	createdAt: integer('created_at').notNull()
});

export interface PromotedFrom {
	hostId: string;
	snapshotId: string | null;
	writeSeq: number;
	generation: number;
}

/** One row: the owner. */
export const user = sqliteTable('user', {
	id: integer('id').primaryKey(),
	displayName: text('display_name').notNull().default(''),
	passwordHash: text('password_hash').notNull(),
	/** totp_* and recovery_code: unused since two-factor sign-in was removed (2026-11-16); kept so older data and backups still open. */
	totpSecret: text('totp_secret'),
	totpEnabled: integer('totp_enabled', { mode: 'boolean' }).notNull().default(false),
	testDate: text('test_date'),
	goalScore: integer('goal_score'),
	weeklyHours: real('weekly_hours'),
	/** Weekdays the owner studies, 0 = Sunday. */
	studyDays: text('study_days', { mode: 'json' }).$type<number[]>().notNull().default(sql`'[1,2,3,4,5,6]'`),
	dayStartHour: integer('day_start_hour').notNull().default(4),
	timeZone: text('time_zone').notNull().default('UTC'),
	newCardsPerDay: integer('new_cards_per_day').notNull().default(20),
	desiredRetention: real('desired_retention').notNull().default(0.9),
	/** Lapses after which a card is flagged as a leech (Anki's default is 8). */
	leechThreshold: integer('leech_threshold').notNull().default(8),
	/** Which AI connection the tutor uses: chatgpt | claude | openai, or null for none. */
	aiProvider: text('ai_provider'),
	baseline: text('baseline', { mode: 'json' }).$type<Baseline | null>(),
	/** Theme, page style, text size and decorations, shared by every device (each device can override the theme). */
	appearance: text('appearance', { mode: 'json' }).$type<Record<string, unknown> | null>(),
	/** Focus timer (Pomodoro), break activities and session presets (see study-prefs.ts). */
	studyPrefs: text('study_prefs', { mode: 'json' }).$type<Record<string, unknown> | null>(),
	/** CARS practice: the daily passage goal (see cars.ts). */
	carsPrefs: text('cars_prefs', { mode: 'json' }).$type<Record<string, unknown> | null>(),
	onboardedAt: integer('onboarded_at'),
	/** When the first-time guide (the tour of every tab) was finished or skipped; null shows it once. */
	guideDoneAt: integer('guide_done_at'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

export interface Baseline {
	kind: 'diagnostic' | 'confidence';
	date?: string;
	total?: number | null;
	cp?: number | null;
	cars?: number | null;
	bb?: number | null;
	ps?: number | null;
}

export const recoveryCode = sqliteTable('recovery_code', {
	id: text('id').primaryKey(),
	codeHash: text('code_hash').notNull(),
	usedAt: integer('used_at'),
	createdAt: integer('created_at').notNull()
});

// ---------------------------------------------------------------- Library

export const document = sqliteTable('document', {
	id: text('id').primaryKey(),
	title: text('title').notNull(),
	kind: text('kind').notNull().default('pdf'),
	fileHash: text('file_hash').notNull(),
	fileName: text('file_name').notNull(),
	fileSize: integer('file_size').notNull(),
	pageCount: integer('page_count'),
	/** queued → processing → ready, or failed */
	status: text('status').notNull().default('queued'),
	error: text('error'),
	/** Shown with a ready book, e.g. when no selectable text was found (scanned PDF). */
	notice: text('notice'),
	currentVersionId: text('current_version_id'),
	/** Where the text came from: original, ocr, web-saved (Section 12.5). */
	provenance: text('provenance').notNull().default('original'),
	license: text('license'),
	lastPage: integer('last_page'),
	furthestPage: integer('furthest_page'),
	lastOpenedAt: integer('last_opened_at'),
	/** book (Library) | notes (a PDF of the owner's own notes, shown under Notes and linked to book pages) */
	role: text('role').notNull().default('book'),
	/**
	 * Pages the owner has marked done (chapters checked off, or "read up to page N"),
	 * as merged [from, to] ranges. Book progress comes from these, never from pages
	 * merely opened; they survive re-processing the PDF because pages don't change.
	 */
	readRanges: text('read_ranges', { mode: 'json' }).$type<[number, number][]>().notNull().default(sql`'[]'`),
	/** When readRanges last changed. */
	progressAt: integer('progress_at'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

/** Links a notes PDF (or some of its pages) to pages of a book. */
export const noteLink = sqliteTable(
	'note_link',
	{
		id: text('id').primaryKey(),
		/** The notes PDF (a document with role 'notes'). */
		notesDocumentId: text('notes_document_id')
			.notNull()
			.references(() => document.id),
		/** Pages of the notes PDF this link covers; null means the whole file. */
		notesPageFrom: integer('notes_page_from'),
		notesPageTo: integer('notes_page_to'),
		bookDocumentId: text('book_document_id')
			.notNull()
			.references(() => document.id),
		bookPageFrom: integer('book_page_from').notNull(),
		bookPageTo: integer('book_page_to').notNull(),
		label: text('label').notNull().default(''),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [index('note_link_book').on(t.bookDocumentId, t.bookPageFrom), index('note_link_notes').on(t.notesDocumentId)]
);

/** A text extraction of a document. Re-extracting creates a new version; anchors keep pointing at theirs. */
export const documentVersion = sqliteTable('document_version', {
	id: text('id').primaryKey(),
	documentId: text('document_id')
		.notNull()
		.references(() => document.id),
	extractionVersion: text('extraction_version').notNull(),
	status: text('status').notNull().default('processing'),
	pageCount: integer('page_count'),
	createdAt: integer('created_at').notNull(),
	completedAt: integer('completed_at')
});

export const docPage = sqliteTable(
	'doc_page',
	{
		id: text('id').primaryKey(),
		versionId: text('version_id')
			.notNull()
			.references(() => documentVersion.id),
		pageNumber: integer('page_number').notNull(),
		width: real('width').notNull(),
		height: real('height').notNull(),
		text: text('text').notNull(),
		/** [[start, end, x0, y0, x1, y1], ...] per text run; boxes are 0–1 fractions of the page. */
		items: text('items').notNull(),
		provenance: text('provenance').notNull().default('original')
	},
	(t) => [uniqueIndex('doc_page_version_page').on(t.versionId, t.pageNumber)]
);

/** Chapters from the PDF outline (or one section for the whole book), with AAMC tags. */
export const docSection = sqliteTable(
	'doc_section',
	{
		id: text('id').primaryKey(),
		documentId: text('document_id')
			.notNull()
			.references(() => document.id),
		title: text('title').notNull(),
		level: integer('level').notNull().default(0),
		position: integer('position').notNull(),
		pageStart: integer('page_start').notNull(),
		pageEnd: integer('page_end').notNull(),
		/** Owner-confirmed AAMC categories. */
		aamcCodes: text('aamc_codes', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
		/** Keyword-match suggestions: [{ code, score }]. */
		suggestedCodes: text('suggested_codes', { mode: 'json' })
			.$type<{ code: string; score: number }[]>()
			.notNull()
			.default(sql`'[]'`),
		confirmed: integer('confirmed', { mode: 'boolean' }).notNull().default(false)
	},
	(t) => [index('doc_section_doc').on(t.documentId, t.position)]
);

/**
 * Where highlights, annotations, cards and citations point: a document version,
 * page and region, plus a copy of the exact text. Never modified after creation.
 */
export const anchor = sqliteTable(
	'anchor',
	{
		id: text('id').primaryKey(),
		documentId: text('document_id').notNull(),
		versionId: text('version_id').notNull(),
		pageNumber: integer('page_number').notNull(),
		/** 'text' (a selection) or 'region' (a box drawn over a figure, table or equation). */
		kind: text('kind').notNull(),
		/** [[x0, y0, x1, y1], ...] as 0–1 fractions of the page, top-left origin. */
		rects: text('rects', { mode: 'json' }).$type<number[][]>().notNull(),
		textStart: integer('text_start'),
		textEnd: integer('text_end'),
		exact: text('exact').notNull().default(''),
		prefix: text('prefix').notNull().default(''),
		suffix: text('suffix').notNull().default(''),
		/** Section title at creation time, for labels like "Biology 2e · 6.5". */
		sectionTitle: text('section_title'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('anchor_doc_page').on(t.documentId, t.pageNumber)]
);

export const highlight = sqliteTable(
	'highlight',
	{
		id: text('id').primaryKey(),
		anchorId: text('anchor_id')
			.notNull()
			.references(() => anchor.id),
		documentId: text('document_id').notNull(),
		color: text('color').notNull().default('yellow'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [index('highlight_doc').on(t.documentId)]
);

/** A reading note (Markdown). "Note" is reserved for Anki-style notes. */
export const annotation = sqliteTable(
	'annotation',
	{
		id: text('id').primaryKey(),
		anchorId: text('anchor_id').references(() => anchor.id),
		documentId: text('document_id'),
		body: text('body').notNull(),
		rev: integer('rev').notNull().default(1),
		/** owner | ai (an approved AI-generated note: never used as evidence by the tutor) */
		origin: text('origin').notNull().default('owner'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [index('annotation_doc').on(t.documentId)]
);

export const annotationRevision = sqliteTable(
	'annotation_revision',
	{
		id: text('id').primaryKey(),
		annotationId: text('annotation_id')
			.notNull()
			.references(() => annotation.id),
		rev: integer('rev').notNull(),
		body: text('body').notNull(),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('annotation_revision_annotation').on(t.annotationId)]
);

// ------------------------------------------------------------- Flashcards

/**
 * Anki-compatible note types. The three built-in ones are created by the first
 * migration; imported Anki note types (id 'anki-<Anki id>') keep their own
 * fields, templates and styling and are rendered with Anki's template rules.
 */
export const noteType = sqliteTable('note_type', {
	id: text('id').primaryKey(),
	name: text('name').notNull(),
	/** basic | basic_reversed | cloze (built-in); anki_standard | anki_cloze (imported) */
	kind: text('kind').notNull(),
	fields: text('fields', { mode: 'json' }).$type<string[]>().notNull(),
	templates: text('templates', { mode: 'json' }).$type<{ name: string; front: string; back: string }[]>().notNull(),
	builtin: integer('builtin', { mode: 'boolean' }).notNull().default(false),
	/** Card styling from Anki (applies inside the card frame only). */
	css: text('css').notNull().default(''),
	/** builtin | anki */
	source: text('source').notNull().default('builtin'),
	/** Field shown in card lists (Anki's sort field). */
	sortField: integer('sort_field').notNull().default(0),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at')
});

export const note = sqliteTable(
	'note',
	{
		id: text('id').primaryKey(),
		noteTypeId: text('note_type_id')
			.notNull()
			.references(() => noteType.id),
		/** Field name → content. */
		fields: text('fields', { mode: 'json' }).$type<Record<string, string>>().notNull(),
		/** markdown (made here) or html (imported) */
		format: text('format').notNull().default('markdown'),
		tags: text('tags', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
		aamcCode: text('aamc_code'),
		anchorId: text('anchor_id').references(() => anchor.id),
		/** Anki note GUID: identity for re-import and export. */
		guid: text('guid').notNull(),
		/** owner | anki | ai */
		origin: text('origin').notNull().default('owner'),
		rev: integer('rev').notNull().default(1),
		/** For Anki notes: `rev` right after the last import wrote it. A higher rev means it was edited here since. */
		importedRev: integer('imported_rev'),
		/** For Anki notes: hash of the fields and tags as last imported, to tell whether the deck changed them. */
		importedHash: text('imported_hash'),
		/** The Anki import that last wrote this note. */
		importId: text('import_id'),
		/** The note's id in the owner's Anki collection (Anki sync). */
		ankiNoteId: integer('anki_note_id'),
		/** `rev` last sent to Anki, so edits made here are sent once. */
		ankiPushedRev: integer('anki_pushed_rev'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [uniqueIndex('note_guid').on(t.guid), index('note_anchor').on(t.anchorId)]
);

/** A card is one template of a note. Its FSRS state is derived from its review events. */
export const card = sqliteTable(
	'card',
	{
		id: text('id').primaryKey(),
		noteId: text('note_id')
			.notNull()
			.references(() => note.id),
		/** Template position (Anki "ord"): 0 front, 1 reverse; cloze number − 1. */
		ord: integer('ord').notNull().default(0),
		due: integer('due').notNull(),
		stability: real('stability').notNull().default(0),
		difficulty: real('difficulty').notNull().default(0),
		elapsedDays: integer('elapsed_days').notNull().default(0),
		scheduledDays: integer('scheduled_days').notNull().default(0),
		learningSteps: integer('learning_steps').notNull().default(0),
		reps: integer('reps').notNull().default(0),
		lapses: integer('lapses').notNull().default(0),
		/** 0 New, 1 Learning, 2 Review, 3 Relearning */
		state: integer('state').notNull().default(0),
		lastReview: integer('last_review'),
		/** Bumped on every review; review events record the revision they were based on. */
		rev: integer('rev').notNull().default(0),
		suspended: integer('suspended', { mode: 'boolean' }).notNull().default(false),
		/** Failed repeatedly (CARD-08). A flag for the owner only: scheduling and suspension are untouched. */
		leech: integer('leech', { mode: 'boolean' }).notNull().default(false),
		/** Anki deck an imported card came from, like "MCAT::Biochemistry". */
		deck: text('deck'),
		/** Anki's new-card position, so new cards come in the deck's own order. Null for cards made here. */
		position: integer('position'),
		/** The card's id in the owner's Anki collection (Anki sync). */
		ankiCardId: integer('anki_card_id'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [index('card_due').on(t.due), index('card_note').on(t.noteId), index('card_anki').on(t.ankiCardId)]
);

/**
 * A due date set by hand ("Set due date"), kept like a review: replaying a card
 * applies its reviews and due-date changes in time order. Only the due date
 * moves; what the scheduler knows about the card's memory is unchanged.
 */
export const cardDueChange = sqliteTable(
	'card_due_change',
	{
		id: text('id').primaryKey(),
		cardId: text('card_id')
			.notNull()
			.references(() => card.id),
		/** New due time (ms). For a new card: not shown before this time. */
		due: integer('due').notNull(),
		prevDue: integer('prev_due').notNull(),
		/** manual | anki */
		source: text('source').notNull().default('manual'),
		changedAt: integer('changed_at').notNull(),
		studyDay: text('study_day').notNull()
	},
	(t) => [index('card_due_change_card').on(t.cardId, t.changedAt)]
);

/** Scheduler identity and parameters, referenced by every review so replays are exact. */
export const schedulerConfig = sqliteTable('scheduler_config', {
	id: text('id').primaryKey(),
	scheduler: text('scheduler').notNull(),
	params: text('params', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
	createdAt: integer('created_at').notNull()
});

/** Permanent record of one review. Card state is recomputed by replaying these in order. */
export const reviewEvent = sqliteTable(
	'review_event',
	{
		id: text('id').primaryKey(),
		cardId: text('card_id')
			.notNull()
			.references(() => card.id),
		rating: integer('rating').notNull(),
		/** guess | unsure | sure — recorded only, never changes scheduling. */
		confidence: text('confidence'),
		reviewedAt: integer('reviewed_at').notNull(),
		timeTakenMs: integer('time_taken_ms').notNull().default(0),
		deviceId: text('device_id').notNull(),
		deviceSeq: integer('device_seq').notNull(),
		baseRev: integer('base_rev').notNull(),
		schedulerConfigId: text('scheduler_config_id')
			.notNull()
			.references(() => schedulerConfig.id),
		/** Interval-fuzz seed handed to the scheduler. */
		seed: text('seed').notNull(),
		receivedAt: integer('received_at').notNull(),
		studyDay: text('study_day').notNull(),
		prevState: integer('prev_state').notNull(),
		prevDue: integer('prev_due').notNull(),
		nextState: integer('next_state').notNull(),
		nextDue: integer('next_due').notNull(),
		nextStability: real('next_stability').notNull(),
		nextDifficulty: real('next_difficulty').notNull()
	},
	(t) => [
		index('review_event_card').on(t.cardId, t.reviewedAt),
		index('review_event_day').on(t.studyDay),
		uniqueIndex('review_event_device_seq').on(t.deviceId, t.deviceSeq)
	]
);

/**
 * Every suspend or unsuspend made here: by hand, or by a book linked to a deck
 * (finishing a chapter unsuspends its cards). Grouped by batch so one Undo puts
 * a whole change back, and sent to Anki by the sync (anki_pushed_at).
 */
export const cardSuspendChange = sqliteTable(
	'card_suspend_change',
	{
		id: text('id').primaryKey(),
		cardId: text('card_id')
			.notNull()
			.references(() => card.id),
		suspended: integer('suspended', { mode: 'boolean' }).notNull(),
		prev: integer('prev', { mode: 'boolean' }).notNull(),
		/** manual | book | undo */
		source: text('source').notNull(),
		batchId: text('batch_id'),
		/** Shown in the history, e.g. "Finished 5.4 Substitution Reactions". */
		reason: text('reason').notNull().default(''),
		changedAt: integer('changed_at').notNull(),
		ankiPushedAt: integer('anki_pushed_at')
	},
	(t) => [index('card_suspend_change_card').on(t.cardId, t.changedAt), index('card_suspend_change_batch').on(t.batchId), index('card_suspend_change_push').on(t.ankiPushedAt)]
);

/** An Anki deck (and its subdecks) linked to a book: its cards follow the owner's progress through the book. */
export const deckBookLink = sqliteTable(
	'deck_book_link',
	{
		id: text('id').primaryKey(),
		/** Full deck name, like "AnKing MCAT" or "MCAT::Biochemistry". */
		deck: text('deck').notNull(),
		documentId: text('document_id')
			.notNull()
			.references(() => document.id),
		/** Keep never-studied cards of unfinished chapters suspended. */
		suspendUnread: integer('suspend_unread', { mode: 'boolean' }).notNull().default(true),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [index('deck_book_link_doc').on(t.documentId)]
);

/**
 * Which cards of a linked deck go with which pages of the book: an Anki tag
 * (and the tags under it) or a subdeck, matched to a page range (a chapter).
 * Cards come out of suspension once every range they're matched to is done.
 */
export const deckBookMap = sqliteTable(
	'deck_book_map',
	{
		id: text('id').primaryKey(),
		linkId: text('link_id')
			.notNull()
			.references(() => deckBookLink.id),
		/** tag | deck */
		targetKind: text('target_kind').notNull(),
		target: text('target').notNull(),
		pageFrom: integer('page_from').notNull(),
		pageTo: integer('page_to').notNull(),
		/** The chapter's title when it was matched. */
		label: text('label').notNull().default(''),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('deck_book_map_link').on(t.linkId)]
);

/** Deletion markers so a stale copy can't bring deleted items back after a restore or sync. */
export const tombstone = sqliteTable(
	'tombstone',
	{
		id: text('id').primaryKey(),
		recordType: text('record_type').notNull(),
		recordId: text('record_id').notNull(),
		deletedAt: integer('deleted_at').notNull()
	},
	(t) => [index('tombstone_record').on(t.recordType, t.recordId)]
);

// --------------------------------------------------------- MCAT practice

/** Owner-made (later AI-generated) questions. Attempts are kept separately (PRAC-06 ready). */
export const question = sqliteTable('question', {
	id: text('id').primaryKey(),
	stem: text('stem').notNull(),
	choices: text('choices', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
	answer: text('answer'),
	explanation: text('explanation'),
	origin: text('origin').notNull().default('owner'),
	aamcCode: text('aamc_code'),
	skillCode: text('skill_code'),
	anchorId: text('anchor_id').references(() => anchor.id),
	/** Every source anchor (AI-generated questions can cite several passages). */
	sources: text('sources', { mode: 'json' }).$type<string[]>().notNull().default(sql`'[]'`),
	documentId: text('document_id'),
	approvalStatus: text('approval_status').notNull().default('approved'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
	deletedAt: integer('deleted_at')
});

export const practiceSet = sqliteTable(
	'practice_set',
	{
		id: text('id').primaryKey(),
		date: text('date').notNull(),
		source: text('source').notNull(),
		section: text('section'),
		aamcCode: text('aamc_code'),
		skillCode: text('skill_code'),
		total: integer('total').notNull(),
		correct: integer('correct').notNull(),
		minutes: integer('minutes'),
		notes: text('notes').notNull().default(''),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [index('practice_set_date').on(t.date)]
);

export const fullLength = sqliteTable(
	'full_length',
	{
		id: text('id').primaryKey(),
		date: text('date').notNull(),
		provider: text('provider').notNull(),
		form: text('form').notNull().default(''),
		total: integer('total'),
		cp: integer('cp'),
		cars: integer('cars'),
		bb: integer('bb'),
		ps: integer('ps'),
		notes: text('notes').notNull().default(''),
		/** Extras from an imported score report: percentiles, time used, where it came from. */
		details: text('details', { mode: 'json' }).$type<Record<string, unknown> | null>(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [index('full_length_date').on(t.date)]
);

/** One question of a full-length (imported from the AAMC review screen, or entered here): right or wrong, and what it tested. */
export const fullLengthItem = sqliteTable(
	'full_length_item',
	{
		id: text('id').primaryKey(),
		fullLengthId: text('full_length_id')
			.notNull()
			.references(() => fullLength.id),
		/** CP | CARS | BB | PS */
		section: text('section').notNull(),
		/** Question number within the section (1-based). */
		number: integer('number').notNull(),
		/** null: skipped / not answered. */
		correct: integer('correct', { mode: 'boolean' }),
		yourAnswer: text('your_answer'),
		correctAnswer: text('correct_answer'),
		/** AAMC content category (e.g. 1A) and skill (e.g. SIRS2, CARS1). */
		aamcCode: text('aamc_code'),
		skillCode: text('skill_code'),
		/** Topic or passage label from the report, free text. */
		topic: text('topic').notNull().default(''),
		seconds: integer('seconds'),
		flagged: integer('flagged', { mode: 'boolean' }).notNull().default(false),
		/** The mistake journal entry made from this question, if any. */
		mistakeId: text('mistake_id'),
		note: text('note').notNull().default(''),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [index('full_length_item_fl').on(t.fullLengthId, t.section, t.number)]
);

// ------------------------------------------------------------------ CARS

/** A CARS passage brought in from Jack Westin's daily passages, AAMC material, or pasted in. */
export const carsPassage = sqliteTable(
	'cars_passage',
	{
		id: text('id').primaryKey(),
		/** jackwestin | aamc | other */
		source: text('source').notNull(),
		sourceUrl: text('source_url').notNull().default(''),
		/** Identity for re-imports (the page's address without query, or a hash of the passage). */
		sourceKey: text('source_key').notNull(),
		title: text('title').notNull(),
		/** The day it was published, 'YYYY-MM-DD', when the page says. */
		publishedOn: text('published_on'),
		/** Subject (Humanities, Social sciences…) when the page says. */
		topic: text('topic').notNull().default(''),
		/** The passage as paragraphs (plain text; paragraphs separated by blank lines). */
		body: text('body').notNull(),
		wordCount: integer('word_count').notNull().default(0),
		/** imported | extracted (by AI from the page) | pasted */
		method: text('method').notNull().default('imported'),
		/** The study day it was imported on (counts toward the daily goal). */
		importedDay: text('imported_day').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [uniqueIndex('cars_passage_key').on(t.sourceKey), index('cars_passage_day').on(t.importedDay)]
);

export const carsQuestion = sqliteTable(
	'cars_question',
	{
		id: text('id').primaryKey(),
		passageId: text('passage_id')
			.notNull()
			.references(() => carsPassage.id),
		position: integer('position').notNull(),
		stem: text('stem').notNull(),
		choices: text('choices', { mode: 'json' }).$type<string[]>().notNull(),
		/** Index of the correct choice, when known. */
		answer: integer('answer'),
		explanation: text('explanation').notNull().default(''),
		/** CARS skill when known: FC (foundations of comprehension), RWT (reasoning within the text), RBT (reasoning beyond the text). */
		skill: text('skill'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('cars_question_passage').on(t.passageId, t.position)]
);

/** One timed try at a passage: every answer and the time on each question. */
export const carsAttempt = sqliteTable(
	'cars_attempt',
	{
		id: text('id').primaryKey(),
		passageId: text('passage_id')
			.notNull()
			.references(() => carsPassage.id),
		startedAt: integer('started_at').notNull(),
		finishedAt: integer('finished_at').notNull(),
		/** Time spent, pauses excluded. */
		seconds: integer('seconds').notNull(),
		/** Seconds spent reading before the first answer. */
		readingSeconds: integer('reading_seconds').notNull().default(0),
		correct: integer('correct').notNull(),
		/** Questions with a known answer key. */
		scored: integer('scored').notNull(),
		total: integer('total').notNull(),
		answers: text('answers', { mode: 'json' }).$type<{ questionId: string; choice: number | null; correct: boolean | null; seconds: number }[]>().notNull(),
		studyDay: text('study_day').notNull(),
		createdAt: integer('created_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [index('cars_attempt_passage').on(t.passageId), index('cars_attempt_day').on(t.studyDay)]
);

export const mistake = sqliteTable(
	'mistake',
	{
		id: text('id').primaryKey(),
		/** practice | full_length | card | external */
		sourceType: text('source_type').notNull(),
		sourceRef: text('source_ref').notNull().default(''),
		fullLengthId: text('full_length_id').references(() => fullLength.id),
		practiceSetId: text('practice_set_id').references(() => practiceSet.id),
		cardId: text('card_id').references(() => card.id),
		aamcCode: text('aamc_code'),
		skillCode: text('skill_code'),
		reason: text('reason').notNull(),
		summary: text('summary').notNull().default(''),
		whatToDo: text('what_to_do').notNull().default(''),
		/** open → repair → retest → resolved; a failed retest goes back to open */
		state: text('state').notNull().default('open'),
		repairExplanation: text('repair_explanation').notNull().default(''),
		passageRevisited: integer('passage_revisited', { mode: 'boolean' }).notNull().default(false),
		retestDue: text('retest_due'),
		reopenedCount: integer('reopened_count').notNull().default(0),
		resolvedAt: integer('resolved_at'),
		studyDay: text('study_day').notNull(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [index('mistake_state').on(t.state), index('mistake_fl').on(t.fullLengthId)]
);

export const mistakeLink = sqliteTable(
	'mistake_link',
	{
		id: text('id').primaryKey(),
		mistakeId: text('mistake_id')
			.notNull()
			.references(() => mistake.id),
		/** card | anchor */
		kind: text('kind').notNull(),
		refId: text('ref_id').notNull(),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('mistake_link_mistake').on(t.mistakeId)]
);

export const mistakeEvent = sqliteTable(
	'mistake_event',
	{
		id: text('id').primaryKey(),
		mistakeId: text('mistake_id')
			.notNull()
			.references(() => mistake.id),
		fromState: text('from_state'),
		toState: text('to_state').notNull(),
		note: text('note').notNull().default(''),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('mistake_event_mistake').on(t.mistakeId)]
);

/** One answer to a question: a retest, a quiz item, or a logged outside question. */
export const attempt = sqliteTable(
	'attempt',
	{
		id: text('id').primaryKey(),
		questionId: text('question_id').references(() => question.id),
		externalRef: text('external_ref').notNull().default(''),
		/** retest | quiz | practice */
		source: text('source').notNull(),
		attemptNumber: integer('attempt_number').notNull().default(1),
		answer: text('answer'),
		correct: integer('correct', { mode: 'boolean' }).notNull(),
		confidence: text('confidence'),
		timeMs: integer('time_ms'),
		aamcCode: text('aamc_code'),
		skillCode: text('skill_code'),
		mistakeId: text('mistake_id').references(() => mistake.id),
		attemptedAt: integer('attempted_at').notNull(),
		studyDay: text('study_day').notNull(),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('attempt_mistake').on(t.mistakeId), index('attempt_day').on(t.studyDay)]
);

// ------------------------------------------------------ Tracking/planning

/** Time spent studying, built from activity heartbeats. */
export const studySession = sqliteTable(
	'study_session',
	{
		id: text('id').primaryKey(),
		/** review | reading | mistakes | practice */
		activity: text('activity').notNull(),
		startedAt: integer('started_at').notNull(),
		endedAt: integer('ended_at').notNull(),
		seconds: integer('seconds').notNull(),
		studyDay: text('study_day').notNull(),
		documentId: text('document_id'),
		deviceId: text('device_id').notNull().default('')
	},
	(t) => [index('study_session_day').on(t.studyDay)]
);

/** A time-budget session (PLAN-07): the chosen items and how far the owner got. */
export const sessionPlan = sqliteTable('session_plan', {
	id: text('id').primaryKey(),
	budgetMinutes: integer('budget_minutes').notNull(),
	items: text('items', { mode: 'json' }).$type<unknown[]>().notNull(),
	/** planned | active | done | abandoned */
	status: text('status').notNull().default('planned'),
	studyDay: text('study_day').notNull(),
	/** Shown at the top of the session, e.g. "Biochem focus". */
	title: text('title').notNull().default(''),
	/** Focus timer settings for this session (null: no timer). */
	focus: text('focus', { mode: 'json' }).$type<Record<string, unknown> | null>(),
	/** Where the focus timer is: phase, round, when it started, pauses. */
	timer: text('timer', { mode: 'json' }).$type<Record<string, unknown> | null>(),
	createdAt: integer('created_at').notNull(),
	startedAt: integer('started_at'),
	completedAt: integer('completed_at')
});

/** AI-written summaries and suggestions on Today (weekly recap, what to work on, mistake patterns). */
export const aiSummary = sqliteTable(
	'ai_summary',
	{
		id: text('id').primaryKey(),
		/** recap | suggest | mistakes | chapter */
		kind: text('kind').notNull(),
		/** What it is about, e.g. the week or a book section id. */
		scope: text('scope').notNull().default(''),
		text: text('text').notNull(),
		/** Structured extras (suggested session items, cited sources). */
		data: text('data', { mode: 'json' }).$type<Record<string, unknown> | null>(),
		provider: text('provider'),
		model: text('model'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('ai_summary_kind').on(t.kind, t.createdAt)]
);

// -------------------------------------------------------------- Anki sync

/** Reviews made here that were written into the owner's Anki collection, so they aren't pulled back as new. */
export const ankiPush = sqliteTable(
	'anki_push',
	{
		eventId: text('event_id').primaryKey(),
		revlogId: integer('revlog_id').notNull(),
		pushedAt: integer('pushed_at').notNull()
	},
	(t) => [uniqueIndex('anki_push_revlog').on(t.revlogId)]
);

/** One synced Anki deck (a top-level deck and its subdecks): how far reviews and notes have been read. */
export const ankiSyncDeck = sqliteTable('anki_sync_deck', {
	deck: text('deck').primaryKey(),
	enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
	/** Newest Anki review id read from this deck. */
	lastRevlogId: integer('last_revlog_id').notNull().default(0),
	/** When the whole deck was last read in (exported from Anki and imported here). */
	lastImportAt: integer('last_import_at'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

// ------------------------------------------------------------ Anki import

/** Media files from Anki decks, by the file name notes refer to. The bytes live in the file store by hash. */
export const media = sqliteTable('media', {
	name: text('name').primaryKey(),
	hash: text('hash').notNull(),
	ext: text('ext').notNull(),
	size: integer('size').notNull(),
	createdAt: integer('created_at').notNull()
});

/** One Anki package import: what was found, the owner's choices, and the final report (CARD-02). */
export const ankiImport = sqliteTable('anki_import', {
	id: text('id').primaryKey(),
	fileName: text('file_name').notNull(),
	fileSize: integer('file_size').notNull(),
	fileHash: text('file_hash').notNull(),
	/** analyzing → ready → importing → done, or failed / cancelled */
	status: text('status').notNull(),
	progress: real('progress').notNull().default(0),
	message: text('message').notNull().default(''),
	analysis: text('analysis', { mode: 'json' }).$type<unknown>(),
	decisions: text('decisions', { mode: 'json' }).$type<unknown>(),
	result: text('result', { mode: 'json' }).$type<unknown>(),
	error: text('error'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull(),
	finishedAt: integer('finished_at')
});

// --------------------------------------------------------------------- AI

/**
 * API-key connections (Claude, OpenAI). Kept with the owner's data so a standby
 * that takes over has them too; left out of exports. ChatGPT plan sign-in is
 * per device and lives in the local database instead.
 */
export const aiProvider = sqliteTable('ai_provider', {
	/** claude | openai | gemini | openrouter | custom */
	id: text('id').primaryKey(),
	apiKey: text('api_key'),
	model: text('model').notNull(),
	/** "Other (OpenAI-compatible)": the service's address, like http://localhost:11434/v1 for Ollama. */
	baseUrl: text('base_url'),
	/** Optional monthly spending cap in US dollars. */
	monthlyCapUsd: real('monthly_cap_usd'),
	/** Prices used for the cap, US dollars per million tokens. */
	inputPrice: real('input_price'),
	outputPrice: real('output_price'),
	createdAt: integer('created_at').notNull(),
	updatedAt: integer('updated_at').notNull()
});

/** One AI request: tokens and estimated cost, for the monthly cap and the usage display. */
export const aiUsage = sqliteTable(
	'ai_usage',
	{
		id: text('id').primaryKey(),
		provider: text('provider').notNull(),
		model: text('model').notNull(),
		/** tutor | check | generate | quality */
		feature: text('feature').notNull(),
		inputTokens: integer('input_tokens').notNull().default(0),
		outputTokens: integer('output_tokens').notNull().default(0),
		/** Null when the request used a plan allowance instead of an API key. */
		costUsd: real('cost_usd'),
		/** 'YYYY-MM' in UTC. */
		month: text('month').notNull(),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('ai_usage_month').on(t.provider, t.month)]
);

export interface ChatContext {
	kind: 'selection' | 'card' | 'page' | 'section' | 'general';
	documentId?: string | null;
	page?: number | null;
	anchorId?: string | null;
	cardId?: string | null;
	sectionId?: string | null;
	/** Short label shown above the conversation, e.g. the selected passage. */
	label?: string;
}

/** A source the tutor (or a generated item) cites, with a copy of the text so it stays inspectable. */
export interface Citation {
	/** Number shown in the text, [1], [2], … */
	n: number;
	/** web: a page found by the tutor's web research (Research mode), never the owner's material. */
	kind: 'page' | 'figure' | 'annotation' | 'card' | 'web';
	anchorId: string | null;
	documentId: string | null;
	page: number | null;
	refId: string | null;
	label: string;
	exact: string;
	/** Web sources: the page's address. */
	url?: string | null;
	/** Whether the cited text backs the claims that cite it (second model call). */
	support: 'supported' | 'partial' | 'unsupported' | 'unchecked';
}

export interface ClaimCheck {
	text: string;
	sources: number[];
	kind: 'content' | 'strategy';
	support: 'supported' | 'partial' | 'unsupported' | 'unchecked' | 'uncited';
	note?: string;
}

export const chatThread = sqliteTable(
	'chat_thread',
	{
		id: text('id').primaryKey(),
		title: text('title').notNull().default(''),
		/** guide | explain | research (searches the web, outside the owner's material) */
		mode: text('mode').notNull().default('guide'),
		context: text('context', { mode: 'json' }).$type<ChatContext | null>(),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		deletedAt: integer('deleted_at')
	},
	(t) => [index('chat_thread_updated').on(t.updatedAt)]
);

export const chatMessage = sqliteTable(
	'chat_message',
	{
		id: text('id').primaryKey(),
		threadId: text('thread_id')
			.notNull()
			.references(() => chatThread.id),
		/** user | assistant */
		role: text('role').notNull(),
		mode: text('mode'),
		text: text('text').notNull(),
		/** answered | not_found | flagged | error */
		status: text('status').notNull().default('answered'),
		citations: text('citations', { mode: 'json' }).$type<Citation[]>().notNull().default(sql`'[]'`),
		claims: text('claims', { mode: 'json' }).$type<ClaimCheck[]>().notNull().default(sql`'[]'`),
		provider: text('provider'),
		model: text('model'),
		createdAt: integer('created_at').notNull()
	},
	(t) => [index('chat_message_thread').on(t.threadId, t.createdAt)]
);

/** AI-generated cards, questions and notes waiting for the owner's approval (AI-02). */
export const generatedItem = sqliteTable(
	'generated_item',
	{
		id: text('id').primaryKey(),
		batchId: text('batch_id').notNull(),
		/** card | question | note */
		kind: text('kind').notNull(),
		content: text('content', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
		sources: text('sources', { mode: 'json' }).$type<Citation[]>().notNull(),
		/** pending | approved | discarded */
		status: text('status').notNull().default('pending'),
		/** A check failed: listed separately and never approved in bulk. */
		flagged: integer('flagged', { mode: 'boolean' }).notNull().default(false),
		checks: text('checks', { mode: 'json' }).$type<{ reference: boolean; support: string; notes: string[] }>(),
		documentId: text('document_id'),
		sectionId: text('section_id'),
		aamcCode: text('aamc_code'),
		/** What approving created: a note, question or annotation id. */
		resultRef: text('result_ref'),
		provider: text('provider'),
		model: text('model'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull()
	},
	(t) => [index('generated_item_status').on(t.status, t.createdAt), index('generated_item_batch').on(t.batchId)]
);

/** Background work (book processing). Restartable: a running job found at startup is redone. */
export const job = sqliteTable(
	'job',
	{
		id: text('id').primaryKey(),
		type: text('type').notNull(),
		payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
		/** queued | running | done | failed */
		status: text('status').notNull().default('queued'),
		attempts: integer('attempts').notNull().default(0),
		progress: real('progress').notNull().default(0),
		message: text('message').notNull().default(''),
		error: text('error'),
		createdAt: integer('created_at').notNull(),
		updatedAt: integer('updated_at').notNull(),
		finishedAt: integer('finished_at')
	},
	(t) => [index('job_status').on(t.status)]
);
