// Checks for the 0.7 features against the real server modules and a throwaway
// data folder: chapter progress, decks linked to books (suspend/unsuspend as you
// read), deleting decks and books with Undo, the CARS importer and attempts,
// full-length question results, card types and image occlusion, and the menu
// and Today layout settings.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cortex-test-v07-'));
process.env.CORTEX_DATA_DIR = dir;
process.env.CORTEX_ENV_LOADED = '1';
process.env.CORTEX_EMBEDDINGS = 'off';
// No AI in these tests: nothing may reach a real service.
for (const k of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY']) process.env[k] = '';

type Mods = {
	config: typeof import('./config');
	db: typeof import('./db');
	schema: typeof import('./db/schema');
	instance: typeof import('./instance');
	cards: typeof import('./cards');
	progress: typeof import('./progress');
	links: typeof import('./deck-links');
	suspend: typeof import('./suspend');
	deletion: typeof import('./deletion');
	cars: typeof import('./cars');
	carsImport: typeof import('./cars-import');
	fl: typeof import('./fl-import');
	types: typeof import('./note-types');
	ranges: typeof import('../ranges');
	appearance: typeof import('../appearance');
	occlusion: typeof import('../occlusion');
};
let m: Mods;

const T0 = Date.parse('2026-11-06T15:00:00Z');
const HASH = 'a'.repeat(64);

beforeAll(async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(T0);
	m = {
		config: await import('./config'),
		db: await import('./db'),
		schema: await import('./db/schema'),
		instance: await import('./instance'),
		cards: await import('./cards'),
		progress: await import('./progress'),
		links: await import('./deck-links'),
		suspend: await import('./suspend'),
		deletion: await import('./deletion'),
		cars: await import('./cars'),
		carsImport: await import('./cars-import'),
		fl: await import('./fl-import'),
		types: await import('./note-types'),
		ranges: await import('../ranges'),
		appearance: await import('../appearance'),
		occlusion: await import('../occlusion')
	};
	m.config.ensureDataDirs();
	m.db.openLocalDatabase();
	await m.db.openMainDatabase();
	m.instance.ensureInstance();
	m.db
		.db()
		.insert(m.schema.user)
		.values({ id: 1, passwordHash: 'x', timeZone: 'America/Chicago', dayStartHour: 4, createdAt: T0, updatedAt: T0 })
		.run();
});

afterAll(async () => {
	vi.useRealTimers();
	await (await import('./ai/indexer')).stopIndexer();
	(await import('./ai/index-db')).closeIndexDb();
	m?.db.closeDatabases();
	fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});

const sql = () => m.db.sqlite();

/** A book with chapters (no PDF needed for progress). */
function addBook(title: string, sections: [string, number, number, number?][], pageCount: number) {
	const id = `doc-${Math.random().toString(36).slice(2)}`;
	m.db.db().insert(m.schema.document).values({ id, title, fileHash: HASH, fileName: `${title}.pdf`, fileSize: 1, pageCount, status: 'ready', createdAt: T0, updatedAt: T0 }).run();
	sections.forEach(([t, from, to, level], i) => {
		m.db
			.db()
			.insert(m.schema.docSection)
			.values({ id: `${id}-s${i}`, documentId: id, title: t, level: level ?? 0, position: i, pageStart: from, pageEnd: to })
			.run();
	});
	return id;
}

/** A card as an Anki import leaves it: in a deck, with tags. */
function addDeckCard(deck: string, tags: string[], front: string, opts: { reviewed?: boolean; ankiId?: number } = {}) {
	const n = m.cards.createNote({ kind: 'basic', fields: { Front: front, Back: 'x' } });
	sql().prepare("UPDATE note SET tags = ?, origin = 'anki' WHERE id = ?").run(JSON.stringify(tags), n.noteId);
	sql().prepare('UPDATE card SET deck = ?, anki_card_id = ? WHERE id = ?').run(deck, opts.ankiId ?? null, n.cardIds[0]);
	if (opts.reviewed) sql().prepare('UPDATE card SET state = 2, reps = 3 WHERE id = ?').run(n.cardIds[0]);
	return n.cardIds[0];
}
const suspended = (id: string) => !!(sql().prepare('SELECT suspended FROM card WHERE id = ?').get(id) as { suspended: number }).suspended;

describe('page ranges', () => {
	it('merges, subtracts and checks coverage', () => {
		const r = m.ranges;
		expect(r.mergeRanges([[5, 9], [1, 3], [4, 4], [20, 25]])).toEqual([[1, 9], [20, 25]]);
		expect(r.subtractRange([[1, 10]], [4, 6])).toEqual([[1, 3], [7, 10]]);
		expect(r.isCovered([[1, 9]], 3, 9)).toBe(true);
		expect(r.isCovered([[1, 3], [5, 9]], 3, 5)).toBe(false);
		expect(r.mergeRanges([[0, 400]], 300)).toEqual([[1, 300]]);
	});

	it('counts progress in the smallest sections', () => {
		const sections = [
			{ id: 'c1', title: 'Chapter 1', level: 0, pageStart: 1, pageEnd: 20 },
			{ id: 'a', title: '1.1', level: 1, pageStart: 1, pageEnd: 10 },
			{ id: 'b', title: '1.2', level: 1, pageStart: 11, pageEnd: 20 },
			{ id: 'c2', title: 'Chapter 2', level: 0, pageStart: 21, pageEnd: 40 }
		];
		expect(m.ranges.leafSections(sections).map((s) => s.id)).toEqual(['a', 'b', 'c2']);
		const p = m.ranges.bookProgress([[1, 10]], 40, sections);
		expect(p).toMatchObject({ pct: 25, pagesDone: 10, sectionsDone: 1, sectionsTotal: 3 });
		expect(m.ranges.chapterKey('5.4 Substitution Reactions')).toBe('5');
		expect(m.ranges.chapterKey('Chapter 12: Lipids')).toBe('12');
		expect(m.ranges.chapterKey('Preface')).toBeNull();
	});
});

describe('book progress', () => {
	it('changes only when chapters are marked, and can be set or reset', () => {
		const book = addBook('Orgo', [['1.1 Covalent Bonds', 1, 6], ['1.2 Hybridization', 7, 10], ['2.1 Molecular Shape', 11, 20]], 20);
		// Opening page 15 (where the old progress came from) doesn't count.
		sql().prepare('UPDATE document SET furthest_page = 15, last_page = 15 WHERE id = ?').run(book);
		expect(m.progress.progressFor(book).pct).toBe(0);
		const r = m.progress.markSections(book, [`${book}-s0`, `${book}-s1`], true);
		expect(r.ranges).toEqual([[1, 10]]);
		expect(r.progress.pct).toBe(50);
		expect(r.previous).toEqual([]);
		const u = m.progress.markSections(book, [`${book}-s0`], false);
		expect(u.ranges).toEqual([[7, 10]]);
		expect(m.progress.setReadUpTo(book, 12).ranges).toEqual([[1, 12]]);
		expect(m.progress.setReadUpTo(book, 0).progress.pct).toBe(0);
	});
});

describe('decks linked to books', () => {
	let book: string;
	const ids: Record<string, string> = {};

	beforeAll(() => {
		book = addBook('UWorld Orgo', [['1.1 Covalent Bonds', 1, 6], ['1.2 Hybridization', 7, 10], ['2.1 Molecular Shape', 11, 20]], 20);
		ids.a1 = addDeckCard('Orgo Deck', ['Orgo::Ch1::1.1_Covalent_Bonds'], 'sigma bond?', { ankiId: 101 });
		ids.a2 = addDeckCard('Orgo Deck', ['Orgo::Ch1::1.1_Covalent_Bonds'], 'pi bond?', { ankiId: 102 });
		ids.b1 = addDeckCard('Orgo Deck', ['Orgo::Ch1::1.2_Hybridization'], 'sp3?');
		ids.c1 = addDeckCard('Orgo Deck', ['Orgo::Ch2::2.1_Molecular_Shape'], 'VSEPR?');
		ids.c2 = addDeckCard('Orgo Deck', ['Orgo::Ch2::2.1_Molecular_Shape'], 'tetrahedral angle?', { reviewed: true });
	});

	it('matches chapters to tags by name and number', () => {
		const s = m.links.suggestMapping(book, 'Orgo Deck');
		const best = s.sections.map((x) => x.options[0]?.target);
		expect(best).toEqual(['Orgo::Ch1::1.1_Covalent_Bonds', 'Orgo::Ch1::1.2_Hybridization', 'Orgo::Ch2::2.1_Molecular_Shape']);
		expect(m.links.autoMaps(s.sections)).toHaveLength(3);
		expect(m.links.numbersOf('Topic1.5_Sleep')).toEqual([1, 5]);
		expect(m.links.numbersOf('Ch05_Learning')).toEqual([5]);
	});

	it('keeps never-studied cards of unread chapters suspended, and leaves studied ones alone', () => {
		const maps = m.links.autoMaps(m.links.suggestMapping(book, 'Orgo Deck').sections);
		const preview = m.links.previewLink(book, 'Orgo Deck', maps, true);
		expect(preview).toMatchObject({ cards: 5, matched: 5, willSuspend: 4, willUnsuspend: 0 });
		const { summary } = m.links.saveLink({ documentId: book, deck: 'Orgo Deck', maps, suspendUnread: true });
		expect(summary.suspended).toBe(4);
		expect([ids.a1, ids.a2, ids.b1, ids.c1].every(suspended)).toBe(true);
		expect(suspended(ids.c2)).toBe(false);
	});

	it('unsuspends a chapter’s cards when it is marked done, with Undo', () => {
		const r = m.progress.markSections(book, [`${book}-s0`], true);
		expect(r.cards?.unsuspended).toBe(2);
		expect(suspended(ids.a1) || suspended(ids.a2)).toBe(false);
		expect(suspended(ids.b1)).toBe(true);
		m.suspend.undoSuspendBatch(r.cards!.batchId);
		expect(suspended(ids.a1) && suspended(ids.a2)).toBe(true);
		m.progress.setRanges(book, r.previous, 'Undo');
		expect(m.progress.progressFor(book).pct).toBe(0);
	});

	it('never unsuspends a card suspended by hand', () => {
		m.progress.markSections(book, [`${book}-s0`], true);
		m.cards.setSuspended(ids.a1, true);
		m.progress.markSections(book, [`${book}-s1`], true);
		m.progress.markSections(book, [`${book}-s0`], true);
		expect(suspended(ids.a1)).toBe(true);
		expect(suspended(ids.a2)).toBe(false);
		expect(suspended(ids.b1)).toBe(false);
	});

	it('lists what to send to Anki, only for cards Anki has', () => {
		const p = m.suspend.pendingAnkiSuspensions();
		expect(p.suspend).toContain(101);
		expect(p.unsuspend).toContain(102);
		expect([...p.suspend, ...p.unsuspend].every((x) => x === 101 || x === 102)).toBe(true);
		m.suspend.markSuspensionsPushed(p.changeIds);
		expect(m.suspend.pendingAnkiSuspensions().changeIds).toHaveLength(0);
	});

	it('unlinking can bring back what the link suspended', () => {
		const link = m.links.listLinks({ documentId: book })[0];
		const s = m.links.deleteLink(link.id, { restore: true });
		expect(s?.unsuspended).toBe(1);
		expect(suspended(ids.c1)).toBe(false);
		expect(suspended(ids.a1)).toBe(true);
	});
});

describe('deleting', () => {
	it('deletes a deck and Undo brings it back', async () => {
		const a = addDeckCard('Psych::Unit 1', ['AP'], 'Freud?');
		const b = addDeckCard('Psych::Unit 2', ['AP'], 'Skinner?');
		const r = await m.deletion.deleteDeck('Psych');
		expect(r.cards).toBe(2);
		expect(m.cards.listCards({ deck: 'Psych' }).total).toBe(0);
		expect(fs.readdirSync(m.config.config.paths.snapshots).some((f) => f.includes('pre-delete'))).toBe(true);
		m.deletion.restoreDeleted(r.deleted);
		expect(m.cards.listCards({ deck: 'Psych' }).total).toBe(2);
		expect([a, b].every((id) => !(sql().prepare('SELECT deleted_at FROM card WHERE id = ?').get(id) as { deleted_at: number | null }).deleted_at)).toBe(true);
	});

	it('deletes a book and keeps the cards made from it unless asked', async () => {
		const book = addBook('Old book', [['1 Intro', 1, 5]], 5);
		const r = await m.deletion.deleteBook(book);
		expect(r.cardsDeleted).toBe(0);
		expect(sql().prepare('SELECT 1 FROM document WHERE id = ?').get(book)).toBeUndefined();
		expect(sql().prepare('SELECT 1 FROM doc_section WHERE document_id = ?').get(book)).toBeUndefined();
	});
});

const PASSAGE = `Daily CARS Passage

The history of the novel is often told as a story of rising realism, in which writers slowly learned to describe ordinary people in ordinary rooms. Yet this account leaves out the many readers who wanted something else entirely from fiction, and who found it in romance, adventure, and the gothic tale.

Critics of the eighteenth century worried that such books would corrupt young readers, filling their heads with impossible hopes. Their complaints tell us less about the books themselves than about the anxieties of a society in which reading had suddenly become cheap, private, and available to almost everyone who wanted it.

When we read these complaints today, we should remember that every new medium has inspired similar fears. The point is not that the critics were wrong to care about what people read, but that their worries reflected changes in who was reading, where they read, and what reading was for in their lives.

1. The author’s main purpose in the passage is to:
A. defend the realist novel against its critics.
B. reframe complaints about popular fiction as signs of social change.
C. argue that romance novels are better than realist ones.
D. show that reading habits have not changed.
Correct answer: B
Explanation: The passage treats the critics' fears as evidence about society.

2. The author mentions "every new medium" in order to:
A. suggest a pattern of recurring anxiety.
B. criticize modern technology.
C. praise eighteenth-century critics.
D. dismiss all concerns about reading.
`;

describe('CARS', () => {
	it('reads numbered questions and lettered choices from page text', () => {
		const r = m.carsImport.parseText(PASSAGE)!;
		expect(r.paragraphs).toHaveLength(3);
		expect(r.questions).toHaveLength(2);
		expect(r.questions[0].choices).toHaveLength(4);
		expect(r.questions[0].answer).toBe(1);
		expect(r.questions[0].explanation).toMatch(/evidence about society/);
		expect(r.questions[1].answer).toBeNull();
	});

	it('finds the passage and questions in a site’s app state', () => {
		const body = PASSAGE.split('\n\n').slice(1, 4).map((p) => `<p>${p}</p>`).join('');
		const json = JSON.stringify({
			data: [{ passage: { title: 'Popular Fiction', content: body, questions: [{ question: 'What is the main idea of the passage?', answers: [{ text: 'A1' }, { text: 'B1', is_correct: true }, { text: 'C1' }, { text: 'D1' }], explanation: 'Because.' }] } }]
		});
		const r = m.carsImport.parseData(json)!;
		expect(r.title).toBe('Popular Fiction');
		expect(r.paragraphs.length).toBe(3);
		expect(r.questions[0]).toMatchObject({ answer: 1, explanation: 'Because.' });
	});

	it('imports a passage, fills in the answer key on a second import, and scores tries', async () => {
		const noKey = PASSAGE.replace(/Correct answer: B\nExplanation:[^\n]*\n/, '');
		const first = await m.carsImport.importCapture({ url: 'https://jackwestin.com/daily/mcat-practice-passages/cars-practice-passages/popular-fiction', title: 'Popular Fiction | Jack Westin', text: noKey }, { useAi: false });
		expect(first).toMatchObject({ created: true, questions: 2, answers: 0 });
		const p = m.cars.getPassage(first.id)!;
		expect(p.passage.source).toBe('jackwestin');
		expect(p.passage.title).toBe('Popular Fiction');
		const attempt = m.cars.recordAttempt(first.id, { startedAt: T0 - 600_000, seconds: 540, readingSeconds: 200, answers: p.questions.map((q, i) => ({ questionId: q.id, choice: i === 0 ? 1 : 0, seconds: 100 })) });
		expect(attempt.scored).toBe(0);
		const again = await m.carsImport.importCapture({ url: 'https://jackwestin.com/daily/mcat-practice-passages/cars-practice-passages/popular-fiction?utm=x', title: 'Popular Fiction', text: PASSAGE }, { useAi: false });
		expect(again).toMatchObject({ id: first.id, created: false, answers: 1, explanations: 1 });
		// Setting the last key by hand rescores the earlier try.
		m.cars.setAnswer(p.questions[1].id, 0);
		const scored = m.cars.getPassage(first.id)!.attempts[0];
		expect(scored).toMatchObject({ correct: 2, scored: 2, total: 2 });
		const stats = m.cars.carsStats();
		expect(stats).toMatchObject({ attempts: 1, correct: 2, scored: 2, avgSeconds: 540 });
		expect(m.cars.carsToday()).toMatchObject({ importedToday: 1, waiting: 0 });
	});

	it('turns down pages without a passage', async () => {
		await expect(m.carsImport.importCapture({ url: 'https://example.com', text: 'Sign in to continue. '.repeat(10) }, { useAi: false })).rejects.toThrow();
	});

	it('adds questions captured one at a time instead of replacing them', async () => {
		const [intro, q1, q2] = [PASSAGE.split('\n1. ')[0], PASSAGE.split('\n1. ')[1].split('\n2. ')[0], PASSAGE.split('\n2. ')[1]];
		const url = 'https://jackwestin.com/daily/mcat-practice-passages/cars-practice-passages/one-at-a-time';
		const first = await m.carsImport.importCapture({ url, title: 'One at a time', text: `${intro}\n1. ${q1}` }, { useAi: false });
		expect(first).toMatchObject({ created: true, questions: 1 });
		// The site's second screen: same passage, only question 2 showing (numbered 1 on screen).
		const second = await m.carsImport.importCapture({ url, title: 'One at a time', text: `${intro}\n1. ${q2}` }, { useAi: false });
		expect(second.id).toBe(first.id);
		const p = m.cars.getPassage(first.id)!;
		expect(p.questions.map((q) => q.stem)).toEqual([expect.stringMatching(/main purpose/), expect.stringMatching(/every new medium/)]);
		expect(p.questions[0].answer).toBe(1);
		// Pressing the bookmark on question 1 again changes nothing.
		await m.carsImport.importCapture({ url, title: 'One at a time', text: `${intro}\n1. ${q1}` }, { useAi: false });
		expect(m.cars.getPassage(first.id)!.questions).toHaveLength(2);
		// Deleted and imported again: starts fresh with what came in.
		m.cars.deletePassage(first.id);
		await m.carsImport.importCapture({ url, title: 'One at a time', text: `${intro}\n1. ${q2}` }, { useAi: false });
		const fresh = m.cars.getPassage(first.id)!;
		expect(fresh.questions.map((q) => q.stem)).toEqual([expect.stringMatching(/every new medium/)]);
	});

	it('reads Nuxt’s flat page data (devalue)', () => {
		const body = PASSAGE.split('\n\n').slice(1, 4).join('\n\n');
		// devalue.stringify({ data: { passage: { title, content, questions: [...] } } }) wrapped the way Nuxt does.
		const flat = [
			['ShallowReactive', 1],
			{ data: 2 },
			['ShallowReactive', 3],
			{ passage: 4 },
			{ title: 5, content: 6, questions: 7 },
			'Popular Fiction',
			body,
			[8],
			{ question: 9, answers: 10, correct_answer: 15 },
			'What is the main idea of the passage?',
			[11, 12, 13, 14],
			'First choice',
			'Second choice',
			'Third choice',
			'Fourth choice',
			'B'
		];
		const r = m.carsImport.parseData(JSON.stringify(flat))!;
		expect(r).not.toBeNull();
		expect(r.title).toBe('Popular Fiction');
		expect(r.questions).toHaveLength(1);
		expect(r.questions[0]).toMatchObject({ choices: ['First choice', 'Second choice', 'Third choice', 'Fourth choice'], answer: 1 });
	});

	it('reads what the browser extension sends: several pieces, the one with the most questions wins', () => {
		const body = PASSAGE.split('\n\n').slice(1, 4).join('\n\n');
		const q = (n: number) => ({ question: `Question ${n}: which claim does the author make?`, answers: [{ text: 'A' }, { text: 'B', is_correct: true }, { text: 'C' }, { text: 'D' }] });
		// The page's own state saw one question; a data response the page loaded had all five.
		const json = JSON.stringify({
			medicusParts: [
				{ from: 'nuxt-payload', value: { passage: { title: 'Ritual Failures', content: body, questions: [q(1)] } } },
				{ from: 'response', url: 'https://api.example/passage/1', value: { data: { title: 'Ritual Failures', body, questions: [1, 2, 3, 4, 5].map(q) } } }
			]
		});
		const r = m.carsImport.parseData(json)!;
		expect(r.questions).toHaveLength(5);
		expect(r.questions.every((x) => x.answer === 1)).toBe(true);
		expect(r.paragraphs.length).toBe(3);
	});

	it('pairs questions from one response with the passage from another', () => {
		const body = PASSAGE.split('\n\n').slice(1, 4).join('\n\n');
		const json = JSON.stringify({
			medicusParts: [
				{ from: 'response', value: { passage: { id: 7, text: body } } },
				{ from: 'response', value: { items: [1, 2, 3].map((n) => ({ stem: `Stem ${n} about the passage?`, options: ['w', 'x', 'y', 'z'] })) } }
			]
		});
		const r = m.carsImport.parseData(json)!;
		expect(r).not.toBeNull();
		expect(r.questions).toHaveLength(3);
		expect(r.paragraphs.join(' ')).toContain(body.split(' ').slice(0, 6).join(' '));
	});
});

describe('CARS capture from the browser extension', () => {
	it('takes the passage from the page and every question from the data it loaded', () => {
		const paras = PASSAGE.split('\n\n').slice(1, 4);
		const qs = [1, 2, 3].map((n) => ({ question: `Question ${n}: Which claim would the author accept (${n})?`, answers: ['Alpha', 'Bravo', 'Charlie', 'Delta'].map((t) => ({ text: `${t} ${n}` })) }));
		const cap = {
			v: 3,
			url: 'https://jackwestin.com/daily/mcat-practice-passages/cars-practice-passages/ritual-failures',
			title: 'Ritual Failures | Jack Westin',
			text: `Ritual Failures\n${paras.join('\n')}\nQuestion 1: Which claim would the author accept (1)?\nA. Alpha 1\nB. Bravo 1\nC. Charlie 1\nD. Delta 1\nNext\nSubmit`,
			frames: ['Question 2: Which claim would the author accept (2)?\nA. Alpha 2\nB. Bravo 2\nC. Charlie 2\nD. Delta 2'],
			data: JSON.stringify({ medicusParts: [{ from: 'response', url: 'https://jackwestin.com/api/passages/ritual-failures', value: { data: { title: 'Ritual Failures', questions: qs } } }] })
		};
		const r = m.carsImport.parseCapture(cap)!;
		expect(r).not.toBeNull();
		expect(r.input.questions).toHaveLength(3);
		expect(r.input.paragraphs.join(' ')).toContain(paras[0].slice(0, 40));
		expect(r.input.questions[2].choices).toEqual(['Alpha 3', 'Bravo 3', 'Charlie 3', 'Delta 3']);
	});
});

// Shaped like Jack Westin's window.dailyData, from a real page saved on 2026-11-07
// (the site's field names; the text here is made up).
const JW_PARAS = [
	...PASSAGE.split('\n\n').slice(1, 4),
	'Readers of the period also left diaries and letters describing what they read and why. These records show that the same person might read a sermon in the morning and a gothic romance at night, finding no contradiction in the habit, because each kind of book answered a different need in an ordinary day.',
	'Publishers understood this better than the critics did. They printed cheap editions in parts, advertised them in newspapers, and sold them in shops that had never before stocked books, so that reading became one more ordinary purchase rather than a mark of education or of wealth.'
];
const JW_KEY = ['d', 'c', 'b', 'b', 'a', 'c'];
const jwStem = (n: number) => `Which claim about reader number ${n} would the author <em>most</em> likely accept?`;
function jwDaily() {
	const passage = { id: 869, title: 'Passage 1', passage: `<p class="hidden"><strong>Passage 1 (Questions 1-6)</strong></p>${JW_PARAS.map((p) => `<p>&nbsp;${p}</p>`).join('')}<p>A. Writer, “On Popular Fiction” (1990) [300 words]</p>`, passage_type: 'PASSAGE' };
	return {
		id: 23740914,
		user_id: 99,
		hash_id: '99-abc',
		title: 'Popular Fiction',
		number_of_questions: 6,
		questions: JW_KEY.map((k, i) => ({
			id: 4269 + i,
			question: `<p>${jwStem(i + 1)}</p>`,
			solution: `<p><strong>${k.toUpperCase()} is correct.</strong> Explanation for question ${i + 1}.</p>`,
			options: ['a', 'b', 'c', 'd'].map((l) => ({ key: `answer_${l}`, value: `<p>Choice ${l.toUpperCase()} for question ${i + 1}</p>`, layout: 'wysiwyg' })),
			...Object.fromEntries(['a', 'b', 'c', 'd'].map((l) => [`answer_${l}`, `Choice ${l.toUpperCase()} for question ${i + 1}`])),
			correct_answer: k,
			selected_answer: null,
			passage,
			tags: [{ id: 294, name: 'Literature' }],
			difficulty: 'Moderate'
		}))
	};
}
/** What Jack Westin's screen shows on question n (the passage, then one question). */
const jwScreen = (n: number) =>
	`Medical College Admission Test - Popular Fiction\n\nTimer: 00:00:00\nHighlight\nStrikethrough\nSolution\n\nPassage 1 (Questions 1 - 6)\n\n${JW_PARAS.join('\n\n')}\n\nQuestion ${n}\nSolution\n\n${jwStem(n).replace(/<\/?em>/g, '')}\n\n${['A', 'B', 'C', 'D'].map((l) => `${l}.\n\nChoice ${l} for question ${n}`).join('\n\n')}\n\nDiscuss • 21\nCancel Comment\nShow comments\n End\n Previous \n Navigation`;

describe('CARS from Jack Westin', () => {
	it('reads window.dailyData: every question, the answer key, explanations and topic', () => {
		const json = JSON.stringify({ medicusParts: [{ from: 'jw-daily', value: jwDaily() }, { from: 'response', url: 'https://api.rudderstack.com/sourceConfig/', value: { source: { id: 'x' } } }] });
		const r = m.carsImport.parseData(json)!;
		expect(r).not.toBeNull();
		expect(r.title).toBe('Popular Fiction');
		expect(r.topic).toBe('Literature');
		expect(r.questions).toHaveLength(6);
		expect(r.questions.map((q) => q.answer)).toEqual([3, 2, 1, 1, 0, 2]);
		expect(r.questions[0].stem).toBe('Which claim about reader number 1 would the author most likely accept?');
		expect(r.questions[0].choices).toEqual(['Choice A for question 1', 'Choice B for question 1', 'Choice C for question 1', 'Choice D for question 1']);
		expect(r.questions[0].explanation).toMatch(/^D is correct\. Explanation for question 1/);
		// The hidden "Passage 1 (Questions 1-6)" line is left out; the source line stays.
		expect(r.paragraphs[0]).toMatch(/^The history of the novel/);
		expect(r.paragraphs.at(-1)).toMatch(/On Popular Fiction/);
	});

	it('finds it in the page HTML that older copies of the extension and bookmark sent', () => {
		// PHP escapes "/" in the page's script, as Jack Westin's does.
		const html = `<div id="question"><p>Question 6</p></div><script>\n window.dailyData = ${JSON.stringify(jwDaily()).replace(/\//g, '\\/')};\n window.loggedIn = true;\n</script>`;
		const cap = {
			v: 3,
			url: 'https://jackwestin.com/daily/mcat-practice-passages/cars-practice-passages/popular-fiction?question=1',
			title: 'AAMC Style Passages | Popular Fiction - Jack Westin',
			text: jwScreen(6),
			html,
			data: JSON.stringify({ medicusParts: [{ from: 'response', value: { source: { id: 'x' } } }] }),
			frames: []
		};
		const r = m.carsImport.parseCapture(cap)!;
		expect(r).not.toBeNull();
		expect(r.complete).toBe(true);
		expect(r.input).toMatchObject({ title: 'Popular Fiction', topic: 'Literature', source: 'jackwestin' });
		expect(r.input.questions).toHaveLength(6);
		expect(r.input.questions.every((q) => q.answer !== null && q.explanation)).toBe(true);
	});

	it('reads Jack Westin’s screen text when there’s no data (choice letters on their own lines)', () => {
		const r = m.carsImport.parseText(jwScreen(6))!;
		expect(r).not.toBeNull();
		expect(r.questions).toHaveLength(1);
		expect(r.questions[0].stem).toBe('Which claim about reader number 6 would the author most likely accept?');
		expect(r.questions[0].choices).toEqual(['Choice A for question 6', 'Choice B for question 6', 'Choice C for question 6', 'Choice D for question 6']);
		expect(r.paragraphs[0]).toMatch(/^The history of the novel/);
	});

	it('a fuller copy puts questions in the site’s order and rescores earlier tries', async () => {
		const url = 'https://jackwestin.com/daily/mcat-practice-passages/cars-practice-passages/popular-fiction-jw';
		const title = 'AAMC Style Passages | Popular Fiction - Jack Westin';
		// What came in before the fix: only the question on screen (question 6), no key.
		const first = await m.carsImport.importCapture({ url: `${url}?question=1`, title, text: jwScreen(6) }, { useAi: false });
		expect(first).toMatchObject({ created: true, questions: 1, answers: 0 });
		const before = m.cars.getPassage(first.id)!;
		const tried = m.cars.recordAttempt(first.id, { startedAt: Date.now() - 60_000, seconds: 60, answers: [{ questionId: before.questions[0].id, choice: 2, seconds: 60 }] });
		expect(tried.scored).toBe(0);
		// The extension now sends the page's data.
		const again = await m.carsImport.importCapture({ url, title, text: jwScreen(1), data: JSON.stringify({ medicusParts: [{ from: 'jw-daily', value: jwDaily() }] }) }, { useAi: false });
		expect(again).toMatchObject({ id: first.id, created: false, questions: 6, answers: 6, explanations: 6, method: 'imported' });
		const after = m.cars.getPassage(first.id)!;
		expect(after.questions.map((q) => q.stem)).toEqual([1, 2, 3, 4, 5, 6].map((n) => expect.stringContaining(`reader number ${n} `)));
		expect(after.questions[5].id).toBe(before.questions[0].id);
		expect(after.passage).toMatchObject({ title: 'Popular Fiction', topic: 'Literature' });
		// C was right for question 6: the earlier try now counts.
		expect(after.attempts[0]).toMatchObject({ correct: 1, scored: 1 });
	});

	it('a deleted passage with tries stays deleted when it’s brought in again', async () => {
		const url = 'https://jackwestin.com/daily/mcat-practice-passages/cars-practice-passages/stays-deleted';
		const first = await m.carsImport.importCapture({ url, title: 'Stays deleted', text: PASSAGE }, { useAi: false });
		const p = m.cars.getPassage(first.id)!;
		m.cars.recordAttempt(first.id, { startedAt: Date.now() - 60_000, seconds: 60, answers: [{ questionId: p.questions[0].id, choice: 1, seconds: 60 }] });
		m.cars.deletePassage(first.id);
		const again = await m.carsImport.importCapture({ url, title: 'Stays deleted', text: PASSAGE }, { useAi: false });
		expect(again.id).not.toBe(first.id);
		expect(m.cars.getPassage(first.id)).toBeNull();
		expect(m.cars.listPassages().filter((x) => x.title === 'Stays deleted')).toHaveLength(1);
	});

	it('only trusts an answer key from the AI when the page shows one', () => {
		expect(m.carsImport.showsAnswers('Correct answer: B')).toBe(true);
		expect(m.carsImport.showsAnswers('C is correct. The passage says…')).toBe(true);
		expect(m.carsImport.showsAnswers(jwScreen(6))).toBe(false);
	});
});

describe('AnKing-style tags', () => {
	it('prefers the branch for the book’s publisher and subject', () => {
		const book = m.links.bookHint('Kaplan MCAT Biochemistry Review 2026');
		expect([...book.publishers]).toEqual(['kaplan']);
		expect([...book.subjects]).toEqual(['biochem']);
		const cand = (target: string) => ({ kind: 'tag' as const, target, label: target.split('::').pop()!, cards: 10, depth: target.split('::').length });
		const kaplan = cand('#AK_MCAT_v2::#Kaplan::Biochemistry::Ch01_Amino_Acids_Peptides_and_Proteins');
		const tpr = cand('#AK_MCAT_v2::#Princeton_Review::Biochemistry::Ch01_Amino_Acids_Peptides_and_Proteins');
		const orgo = cand('#AK_MCAT_v2::#Kaplan::Organic_Chemistry::Ch01_Amino_Acids');
		const title = '1 Amino Acids, Peptides, and Proteins';
		const s = (c: ReturnType<typeof cand>) => m.links.matchScore(title, c, book);
		expect(s(kaplan)).toBeGreaterThan(s(tpr));
		expect(s(kaplan)).toBeGreaterThan(s(orgo));
		// Without a book, the two publishers' tags tie (as before).
		expect(m.links.matchScore(title, kaplan)).toBe(m.links.matchScore(title, tpr));
		expect([...m.links.bookHint('The Princeton Review MCAT Organic Chemistry').subjects]).toEqual(['orgo']);
		expect([...m.links.bookHint('Kaplan General Chemistry Review').subjects]).toEqual(['genchem']);
		expect([...m.links.bookHint('Behavioral Sciences Review').subjects]).toEqual(['psysoc']);
	});
});

describe('full-length question results', () => {
	it('reads lists of question numbers', () => {
		expect(m.fl.parseNumbers('3, 7, 12-14; 99')).toEqual([3, 7, 12, 13, 14]);
		const items = m.fl.itemsFromWrongLists({ CP: '1, 2', CARS: '' }, { CP: '5' });
		expect(items.filter((i) => i.section === 'CP')).toHaveLength(59);
		expect(items.filter((i) => i.section === 'CP' && i.correct === false).map((i) => i.number)).toEqual([1, 2]);
		expect(items.find((i) => i.section === 'CP' && i.number === 5)?.correct).toBeNull();
	});

	it('reads a copied review list without AI', () => {
		const text = `Chemical and Physical Foundations of Biological Systems 127
1 Correct 4A SIRS 2 C B
2 Incorrect 5B SIRS 1 A D
Critical Analysis and Reasoning Skills 125
1 Unanswered FC
Total score 508`;
		const r = m.fl.parseReportText(text);
		expect(r.scores).toMatchObject({ CP: 127, CARS: 125, total: 508 });
		expect(r.items).toHaveLength(3);
		expect(r.items[1]).toMatchObject({ section: 'CP', number: 2, correct: false, aamcCode: '5B', skillCode: 'SIRS-1' });
		expect(r.items[2]).toMatchObject({ section: 'CARS', correct: null, skillCode: 'FC' });
	});

	it('saves an exam with its questions, breaks it down, and logs mistakes once', () => {
		const id = m.fl.saveImport({
			date: '2026-11-01',
			provider: 'AAMC',
			form: 'Practice Exam 3',
			cp: 127,
			cars: 125,
			bb: 128,
			ps: 128,
			items: [
				{ section: 'CP', number: 1, correct: true, aamcCode: '4A' },
				{ section: 'CP', number: 2, correct: false, aamcCode: '5B', skillCode: 'SIRS-1' },
				{ section: 'BB', number: 1, correct: false, aamcCode: '1A' }
			]
		});
		const b = m.fl.breakdown(id);
		expect(b.items).toHaveLength(3);
		expect(b.bySection.find((s) => s.key === 'CP')).toMatchObject({ correct: 1, wrong: 1 });
		const wrong = b.items.filter((i) => i.correct === false).map((i) => i.id);
		expect(m.fl.mistakesFromItems(id, wrong, 'content_gap')).toBe(2);
		expect(m.fl.mistakesFromItems(id, wrong, 'content_gap')).toBe(0);
	});
});

describe('card types and image occlusion', () => {
	it('makes a card per template that shows something', () => {
		const typeId = m.types.createNoteType({
			name: 'Term + example',
			kind: 'standard',
			fields: ['Term', 'Definition', 'Example'],
			templates: [
				{ name: 'Define', front: '{{Term}}', back: '{{FrontSide}}<hr id=answer>{{Definition}}' },
				{ name: 'Name it', front: '{{#Example}}{{Example}}{{/Example}}', back: '{{FrontSide}}<hr id=answer>{{Term}}' }
			],
			css: ''
		});
		const one = m.cards.createTemplatedNote({ noteTypeId: typeId, fields: { Term: 'Km', Definition: 'Half Vmax', Example: '' } });
		expect(one.cardIds).toHaveLength(1);
		const two = m.cards.createTemplatedNote({ noteTypeId: typeId, fields: { Term: 'Vmax', Definition: 'Max rate', Example: 'Saturated enzyme' } });
		expect(two.cardIds).toHaveLength(2);
		// Renaming a field keeps the cards' content.
		m.types.updateNoteType(typeId, {
			name: 'Term + example',
			kind: 'standard',
			fields: ['Word', 'Definition', 'Example'],
			templates: [
				{ name: 'Define', front: '{{Word}}', back: '{{FrontSide}}<hr id=answer>{{Definition}}' },
				{ name: 'Name it', front: '{{#Example}}{{Example}}{{/Example}}', back: '{{FrontSide}}<hr id=answer>{{Word}}' }
			],
			css: '',
			renames: { Term: 'Word' }
		});
		const note = sql().prepare('SELECT fields FROM note WHERE id = ?').get(two.noteId) as { fields: string };
		expect(JSON.parse(note.fields).Word).toBe('Vmax');
		expect(m.types.getNoteTypeView(typeId)?.notes).toBe(2);
	});

	it('rejects a cloze type without a cloze', () => {
		expect(() => m.types.createNoteType({ name: 'Bad', kind: 'cloze', fields: ['Text'], templates: [{ name: 'C', front: '{{Text}}', back: '{{Text}}' }], css: '' })).toThrow(m.types.NoteTypeError);
	});

	it('writes and reads Anki’s image occlusion format, one card per mask group', () => {
		const shapes = [
			{ id: 'a', ord: 1, kind: 'rect' as const, left: 0.1, top: 0.2, width: 0.3, height: 0.25 },
			{ id: 'b', ord: 2, kind: 'ellipse' as const, left: 0.5, top: 0.5, width: 0.2, height: 0.1 },
			{ id: 'c', ord: 2, kind: 'rect' as const, left: 0.7, top: 0.1, width: 0.1, height: 0.1 }
		];
		const text = m.occlusion.occlusionText(shapes, true);
		expect(text).toContain('{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.25:oi=1}}');
		expect(text).toContain('{{c2::image-occlusion:ellipse:left=.5:top=.5:rx=.1:ry=.05:oi=1}}');
		const back = m.occlusion.parseOcclusion(text);
		expect(back.hideAll).toBe(true);
		expect(back.shapes.map((s) => [s.ord, s.kind, s.width])).toEqual([
			[1, 'rect', 0.3],
			[2, 'ellipse', 0.2],
			[2, 'rect', 0.1]
		]);
		m.types.ensureImageOcclusionType();
		const n = m.cards.createTemplatedNote({ noteTypeId: m.types.IO_TYPE_ID, fields: { Occlusion: text, Image: '<img src="heart.png">', Header: '', 'Back Extra': '', Comments: '' } });
		expect(n.cardIds).toHaveLength(2);
		const rendered = m.cards.reviewCard(n.cardIds[0])!;
		expect(rendered.front).toContain('data-shape="rect"');
		expect(rendered.front).toContain('anki.imageOcclusion.setup()');
	});
});

describe('menu and Today layout', () => {
	it('keeps the saved order, drops unknown ids and adds new sections where they belong', () => {
		const { cleanLayout, DEFAULT_HOME, DEFAULT_NAV } = m.appearance;
		const nav = cleanLayout(
			[
				{ id: 'search', visible: true },
				{ id: 'today', visible: false },
				{ id: 'bogus', visible: true },
				{ id: 'search', visible: false }
			],
			DEFAULT_NAV
		);
		expect(nav[0]).toEqual({ id: 'search', visible: true });
		expect(nav[1]).toEqual({ id: 'today', visible: false });
		expect(nav.map((x) => x.id).sort()).toEqual(DEFAULT_NAV.map((x) => x.id).sort());
		const home = cleanLayout([{ id: 'stats', visible: true }, { id: 'start', visible: true }], DEFAULT_HOME);
		expect(home.slice(0, 2).map((x) => x.id)).toEqual(['stats', 'start']);
		expect(home.find((x) => x.id === 'cars')?.visible).toBe(true);
		expect(home.find((x) => x.id === 'forecast')?.visible).toBe(false);
	});
});
