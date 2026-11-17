// Builds small Anki packages for the import tests, in both formats Anki writes:
//  - "legacy" (.apkg with collection.anki21, a JSON media list, plain media files)
//  - "latest" (.apkg with meta, zstd-compressed collection.anki21b, protobuf media list, zstd media files)
// following Anki's own schema (rslib/src/storage) and protobuf messages (proto/anki).
//
//   node tests/fixtures/make-anki-packages.mjs <outDir>
//
// Exported for the tests: makeAnkiPackage(file, options).

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import Database from 'better-sqlite3';
import yazl from 'yazl';

// --------------------------------------------------------------- protobuf

function varint(value) {
	let v = BigInt.asUintN(64, BigInt(value));
	const out = [];
	while (v > 127n) {
		out.push(Number(v & 127n) | 128);
		v >>= 7n;
	}
	out.push(Number(v));
	return Buffer.from(out);
}
const key = (field, wire) => varint((field << 3) | wire);
const pbInt = (field, v) => Buffer.concat([key(field, 0), varint(v)]);
const pbBytes = (field, buf) => Buffer.concat([key(field, 2), varint(buf.length), buf]);
const pbString = (field, s) => pbBytes(field, Buffer.from(s, 'utf8'));
const pbFloat = (field, f) => {
	const b = Buffer.alloc(4);
	b.writeFloatLE(f, 0);
	return Buffer.concat([key(field, 5), b]);
};

// ------------------------------------------------------------------ data

export const PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
	'base64'
);
export const MP3 = Buffer.from('ID3\u0004\u0000\u0000\u0000\u0000\u0000\u0000fake-mp3-for-tests', 'latin1');

const DAY = 86_400_000;
const START = Date.parse('2026-09-01T14:00:00Z');

export const NT = {
	basic: 1700000000101,
	reversed: 1700000000102,
	cloze: 1700000000103,
	scripted: 1700000000104,
	typing: 1700000000105,
	io: 1700000000106,
	ioNative: 1700000000107
};

/** Anki's own image occlusion note type (Anki 23.10+), as its stock templates have it. */
const IO_FRONT =
	'{{#Header}}<div>{{Header}}</div>{{/Header}}\n<div style="display: none">{{cloze:Occlusion}}</div>\n<div id="err"></div>\n<div id="image-occlusion-container">\n    {{Image}}\n    <canvas id="image-occlusion-canvas"></canvas>\n</div>\n<script>\ntry {\n    anki.imageOcclusion.setup();\n} catch (exc) {\n    document.getElementById("err").innerHTML = `Error loading image occlusion. Is your Anki version up to date?<br><br>${exc}`;\n}\n</script>';
const IO_BACK = IO_FRONT + '\n<div><button id="toggle">Toggle Masks</button></div>\n{{#Back Extra}}<div>{{Back Extra}}</div>{{/Back Extra}}';

export const DECK = { default: 1, biochem: 1700000000201, physics: 1700000000202 };

const CARD_CSS = '.card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }';

export const noteTypes = [
	{
		id: NT.basic,
		name: 'Basic',
		kind: 0,
		fields: ['Front', 'Back'],
		templates: [{ name: 'Card 1', q: '{{Front}}', a: '{{FrontSide}}\n\n<hr id=answer>\n\n{{Back}}' }]
	},
	{
		id: NT.reversed,
		name: 'Basic (and reversed card)',
		kind: 0,
		fields: ['Front', 'Back'],
		templates: [
			{ name: 'Card 1', q: '{{Front}}', a: '{{FrontSide}}<hr id=answer>{{Back}}' },
			{ name: 'Card 2', q: '{{Back}}', a: '{{FrontSide}}<hr id=answer>{{Front}}' }
		]
	},
	{
		id: NT.cloze,
		name: 'Cloze',
		kind: 1,
		fields: ['Text', 'Back Extra'],
		templates: [{ name: 'Cloze', q: '{{cloze:Text}}', a: '{{cloze:Text}}<br>\n{{Back Extra}}' }],
		css: CARD_CSS + '\n.cloze { font-weight: bold; color: blue; }'
	},
	{
		id: NT.scripted,
		name: 'Basic (hint button)',
		kind: 0,
		fields: ['Front', 'Back', 'Hint'],
		templates: [
			{
				name: 'Card 1',
				q: '<script>document.body.classList.add("scripted")</script>{{Front}}<button onclick="alert(1)">Hint</button>{{#Hint}}<div>{{hint:Hint}}</div>{{/Hint}}',
				a: '{{FrontSide}}<hr id=answer>{{Back}}'
			}
		]
	},
	{
		id: NT.typing,
		name: 'Basic (type in the answer)',
		kind: 0,
		fields: ['Front', 'Back'],
		templates: [{ name: 'Card 1', q: '{{Front}}\n\n{{type:Back}}', a: '{{Front}}\n\n<hr id=answer>\n\n{{type:Back}}' }]
	},
	{
		id: NT.io,
		name: 'Image Occlusion Enhanced',
		kind: 0,
		fields: ['ID (hidden)', 'Header', 'Image', 'Question Mask', 'Footer', 'Remarks', 'Sources', 'Extra 1', 'Extra 2', 'Answer Mask', 'Original Mask'],
		templates: [{ name: 'IO Card', q: '{{#Image}}<div>{{Image}}{{Question Mask}}</div>{{/Image}}', a: '{{Image}}{{Answer Mask}}' }]
	},
	{
		id: NT.ioNative,
		name: 'Image Occlusion',
		kind: 1,
		stockKind: 6,
		fields: ['Occlusion', 'Image', 'Header', 'Back Extra', 'Comments'],
		templates: [{ name: 'Image Occlusion', q: IO_FRONT, a: IO_BACK }],
		css: '#image-occlusion-canvas { --inactive-shape-color: #ffeba2; --active-shape-color: #ff8e8e; }\n.card { font-family: arial; font-size: 20px; text-align: center; color: black; background-color: white; }'
	}
];

/** A note type with Basic's id but different fields, as another deck by the same author might have. */
export const clashingBasic = {
	id: NT.basic,
	name: 'Basic',
	kind: 0,
	fields: ['Front', 'Back', 'Source'],
	templates: [{ name: 'Card 1', q: '{{Front}}', a: '{{FrontSide}}<hr id=answer>{{Back}}<div class="source">{{Source}}</div>' }]
};

/**
 * The deck. `variant` changes a few things for re-import tests:
 *  v1: the original
 *  v2: one note's back changed, one new note, two more reviews for the kinase card
 *  v3: like v2, plus the Km note changed (for conflict tests)
 *  nohistory: no review log and every card new
 *  clash: one note whose note type has Basic's id but other fields (see clashingBasic)
 * New cards get deck positions in the reverse of the order their notes were
 * made, so tests can tell the deck's order from creation order.
 */
export function deckContent(variant = 'v1') {
	const notes = [];
	const cards = [];
	const revlog = [];
	let nid = 1701000000000;
	let cid = 1702000000000;
	const addNote = (guid, mid, fields, tags, cardDefs) => {
		const id = nid++;
		notes.push({ id, guid, mid, fields, tags, mod: Math.floor(START / 1000) });
		const position = 100 - notes.length;
		for (const def of cardDefs) {
			const id2 = cid++;
			const type = def.type ?? 0;
			cards.push({ id: id2, nid: id, did: def.did ?? DECK.biochem, ord: def.ord ?? 0, type, queue: def.queue ?? 0, due: def.due ?? (type === 0 ? position : 30), ivl: def.ivl ?? 0, odid: def.odid ?? 0 });
			for (const r of def.reviews ?? []) revlog.push({ cid: id2, ...r });
		}
		return id;
	};
	if (variant === 'clash') {
		addNote('clash-guid', NT.basic, ['What carries oxygen in blood?', 'Hemoglobin', 'Biology 2e, ch. 40'], ['bio::blood'], [{ did: DECK.physics }]);
		return { notes, cards, revlog, media: {} };
	}
	const reviews = (pattern, startDay) =>
		pattern.map((ease, i) => ({ id: START + (startDay + i * 3) * DAY + i * 1000, ease, type: i < 2 ? 0 : 1, ivl: 1, lastIvl: 0, factor: 2500, time: 6000 }));

	const kinaseReviews = reviews([3, 3, 3], 0);
	if (variant === 'v2' || variant === 'v3') kinaseReviews.push(...reviews([3, 4], 30));
	addNote('kinase-guid', NT.basic, ['What enzyme class moves a phosphate group from ATP to a substrate?', variant === 'v1' || variant === 'nohistory' ? 'A kinase' : 'A kinase (a phosphotransferase)'], ['biochem::enzymes', 'MCAT'], [
		{ reviews: kinaseReviews, type: 2, queue: 2, ivl: 9 }
	]);
	addNote('km-guid', NT.reversed, ['K<sub>m</sub>', variant === 'v3' ? 'The [S] at which rate is half of V<sub>max</sub> (deck v3)' : 'The [S] at which rate is half of V<sub>max</sub>'], ['biochem::kinetics'], [
		{ ord: 0, reviews: reviews([3, 3], 1), type: 2, queue: 2, ivl: 4 },
		{ ord: 1 }
	]);
	addNote('glyco-guid', NT.cloze, ['{{c1::Glycolysis}} happens in the {{c2::cytoplasm::cell compartment}}.', 'Net yield: 2 ATP'], ['biochem::metabolism'], [
		{ ord: 0, reviews: reviews([1, 3, 3], 2) },
		{ ord: 1 }
	]);
	addNote('nested-guid', NT.cloze, ['{{c1::Oxidative {{c2::phosphorylation}}}} makes most of the cell’s ATP.', ''], ['biochem::metabolism'], [{ ord: 0 }, { ord: 1 }]);
	addNote('hh-guid', NT.basic, ['Henderson–Hasselbalch equation?', '\\(pH = pK_a + \\log\\frac{[A^-]}{[HA]}\\)'], ['chem::acids'], [{ did: DECK.physics }]);
	addNote('image-guid', NT.basic, ['Name this organelle: <img src="cell.png">', 'Mitochondrion [sound:pronounce.mp3]'], ['bio::cell'], [{ queue: -1 }]);
	addNote('script-guid', NT.scripted, ['What does the Na<sup>+</sup>/K<sup>+</sup> pump move per ATP?', '3 Na<sup>+</sup> out, 2 K<sup>+</sup> in', 'Think 3:2'], ['bio::membranes'], [{}]);
	addNote('typing-guid', NT.typing, ['Hormone that lowers blood glucose?', 'Insulin'], ['bio::endocrine'], [{}]);
	addNote('io-guid', NT.io, ['io-1', 'Heart', '<img src="heart.png">', '<img src="heart-Q.svg">', '', '', '', '', '', '<img src="heart-A.svg">', '<img src="heart-O.svg">'], ['bio::anatomy'], [{}]);
	addNote(
		'io-native-guid',
		NT.ioNative,
		[
			'{{c1::image-occlusion:rect:left=.1:top=.2:width=.3:height=.25:oi=1}}<br>{{c2::image-occlusion:ellipse:left=.5:top=.5:rx=.1:ry=.08:oi=1}}',
			'<img src="cell.png">',
			'Name the parts of the cell',
			'',
			''
		],
		['bio::cell'],
		[{ ord: 0 }, { ord: 1 }]
	);
	// 8 lapses: learn (Good, Good), then (Again, Good) eight times.
	addNote('leech-guid', NT.basic, ['Which amino acid has a thioether side chain?', 'Methionine'], ['biochem::amino-acids'], [
		{ reviews: reviews([3, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3, 1, 3], 3), type: 2, queue: 2, ivl: 2 }
	]);
	// A manual "set due date" entry: not a review, must not be imported as one.
	revlog.push({ cid: cards[0].id, id: START + 60 * DAY, ease: 0, type: 4, ivl: 5, lastIvl: 9, factor: 2500, time: 0 });
	if (variant === 'v2' || variant === 'v3') {
		addNote('new-in-v2-guid', NT.basic, ['Where is bile made?', 'The liver'], ['bio::digestion'], [{}]);
	}
	if (variant === 'nohistory') {
		revlog.length = 0;
		for (const c of cards) Object.assign(c, { type: 0, queue: c.queue === -1 ? -1 : 0, ivl: 0 });
	}
	const mask = (fill) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect x="2" y="2" width="5" height="4" fill="${fill}"/></svg>`);
	const media = {
		'cell.png': PNG,
		'pronounce.mp3': MP3,
		'_template-font.woff2': Buffer.from('wOF2-fake'),
		'heart.png': PNG,
		'heart-Q.svg': mask('#ff8e8e'),
		'heart-A.svg': mask('#ffeba2'),
		'heart-O.svg': mask('#ffeba2')
	};
	return { notes, cards, revlog, media };
}

// ------------------------------------------------------------ collection

function createCommonTables(db) {
	db.exec(`
		CREATE TABLE col (id integer PRIMARY KEY, crt integer NOT NULL, mod integer NOT NULL, scm integer NOT NULL, ver integer NOT NULL,
			dty integer NOT NULL, usn integer NOT NULL, ls integer NOT NULL, conf text NOT NULL, models text NOT NULL, decks text NOT NULL,
			dconf text NOT NULL, tags text NOT NULL);
		CREATE TABLE notes (id integer PRIMARY KEY, guid text NOT NULL, mid integer NOT NULL, mod integer NOT NULL, usn integer NOT NULL,
			tags text NOT NULL, flds text NOT NULL, sfld integer NOT NULL, csum integer NOT NULL, flags integer NOT NULL, data text NOT NULL);
		CREATE TABLE cards (id integer PRIMARY KEY, nid integer NOT NULL, did integer NOT NULL, ord integer NOT NULL, mod integer NOT NULL,
			usn integer NOT NULL, type integer NOT NULL, queue integer NOT NULL, due integer NOT NULL, ivl integer NOT NULL, factor integer NOT NULL,
			reps integer NOT NULL, lapses integer NOT NULL, left integer NOT NULL, odue integer NOT NULL, odid integer NOT NULL, flags integer NOT NULL,
			data text NOT NULL);
		CREATE TABLE revlog (id integer PRIMARY KEY, cid integer NOT NULL, usn integer NOT NULL, ease integer NOT NULL, ivl integer NOT NULL,
			lastIvl integer NOT NULL, factor integer NOT NULL, time integer NOT NULL, type integer NOT NULL);
	`);
}

function fillNotesCardsRevlog(db, content) {
	const n = db.prepare('INSERT INTO notes VALUES (?, ?, ?, ?, -1, ?, ?, ?, 0, 0, \'\')');
	for (const note of content.notes) {
		n.run(note.id, note.guid, note.mid, note.mod, note.tags.length ? ` ${note.tags.join(' ')} ` : '', note.fields.join('\u001f'), note.fields[0]);
	}
	const c = db.prepare('INSERT INTO cards VALUES (?, ?, ?, ?, 0, -1, ?, ?, ?, ?, 2500, 0, 0, 0, 0, ?, 0, \'\')');
	for (const card of content.cards) c.run(card.id, card.nid, card.did, card.ord, card.type, card.queue, card.due ?? 0, card.ivl, card.odid ?? 0);
	const r = db.prepare('INSERT INTO revlog VALUES (?, ?, -1, ?, ?, ?, ?, ?, ?)');
	for (const rv of content.revlog) r.run(rv.id, rv.cid, rv.ease, rv.ivl, rv.lastIvl, rv.factor, rv.time, rv.type);
}

function deckConfJson(retention) {
	return {
		1: { id: 1, name: 'Default', new: { perDay: 20 }, lapse: { leechFails: 8, leechAction: 1 }, rev: { perDay: 200 } },
		1700000000301: {
			id: 1700000000301,
			name: 'MCAT preset',
			new: { perDay: 30, delays: [1, 10] },
			lapse: { leechFails: 8, leechAction: 0 },
			rev: { perDay: 300 },
			desiredRetention: retention
		}
	};
}

function legacyCollection(file, content, retention, types) {
	const db = new Database(file);
	createCommonTables(db);
	const models = {};
	for (const t of types) {
		models[t.id] = {
			id: t.id,
			name: t.name,
			type: t.kind,
			flds: t.fields.map((name, ord) => ({ name, ord })),
			tmpls: t.templates.map((tm, ord) => ({ name: tm.name, ord, qfmt: tm.q, afmt: tm.a })),
			css: t.css ?? CARD_CSS,
			sortf: 0,
			...(t.stockKind ? { originalStockKind: t.stockKind } : {})
		};
	}
	const decks = {
		[DECK.default]: { id: DECK.default, name: 'Default', conf: 1, dyn: 0 },
		[DECK.biochem]: { id: DECK.biochem, name: 'MCAT::Biochemistry', conf: 1700000000301, dyn: 0 },
		[DECK.physics]: { id: DECK.physics, name: 'MCAT::Chem-Phys', conf: 1700000000301, dyn: 0 }
	};
	db.prepare('INSERT INTO col VALUES (1, ?, ?, ?, 11, 0, 0, 0, ?, ?, ?, ?, ?)').run(
		Math.floor(START / 1000),
		START,
		START,
		'{}',
		JSON.stringify(models),
		JSON.stringify(decks),
		JSON.stringify(deckConfJson(retention)),
		'{}'
	);
	fillNotesCardsRevlog(db, content);
	db.close();
}

function latestCollection(file, content, retention, types) {
	const db = new Database(file);
	createCommonTables(db);
	db.exec(`
		CREATE TABLE deck_config (id integer PRIMARY KEY NOT NULL, name text NOT NULL COLLATE nocase, mtime_secs integer NOT NULL, usn integer NOT NULL, config blob NOT NULL);
		CREATE TABLE config (KEY text NOT NULL PRIMARY KEY, usn integer NOT NULL, mtime_secs integer NOT NULL, val blob NOT NULL) without rowid;
		CREATE TABLE fields (ntid integer NOT NULL, ord integer NOT NULL, name text NOT NULL COLLATE nocase, config blob NOT NULL, PRIMARY KEY (ntid, ord)) without rowid;
		CREATE UNIQUE INDEX idx_fields_name_ntid ON fields (name, ntid);
		CREATE TABLE templates (ntid integer NOT NULL, ord integer NOT NULL, name text NOT NULL COLLATE nocase, mtime_secs integer NOT NULL, usn integer NOT NULL,
			config blob NOT NULL, PRIMARY KEY (ntid, ord)) without rowid;
		CREATE UNIQUE INDEX idx_templates_name_ntid ON templates (name, ntid);
		CREATE INDEX idx_templates_usn ON templates (usn);
		CREATE TABLE notetypes (id integer NOT NULL PRIMARY KEY, name text NOT NULL COLLATE nocase, mtime_secs integer NOT NULL, usn integer NOT NULL, config blob NOT NULL);
		CREATE UNIQUE INDEX idx_notetypes_name ON notetypes (name);
		CREATE INDEX idx_notetypes_usn ON notetypes (usn);
		CREATE TABLE decks (id integer PRIMARY KEY NOT NULL, name text NOT NULL COLLATE nocase, mtime_secs integer NOT NULL, usn integer NOT NULL, common blob NOT NULL, kind blob NOT NULL);
		CREATE UNIQUE INDEX idx_decks_name ON decks (name);
		CREATE TABLE tags (tag text NOT NULL PRIMARY KEY COLLATE nocase, usn integer NOT NULL, collapsed boolean NOT NULL, config blob NULL) without rowid;
		CREATE TABLE graves (oid integer NOT NULL, type integer NOT NULL, usn integer NOT NULL, PRIMARY KEY (oid, type)) WITHOUT ROWID;
	`);
	db.prepare('INSERT INTO col VALUES (1, ?, ?, ?, 18, 0, 0, 0, ?, ?, ?, ?, ?)').run(Math.floor(START / 1000), START, START, '{}', '{}', '{}', '{}', '{}');
	for (const t of types) {
		// Notetype.Config: kind = 1, sort_field_idx = 2, css = 3, original_stock_kind = 9
		const cfg = Buffer.concat([pbInt(1, t.kind), pbInt(2, 0), pbString(3, t.css ?? CARD_CSS), ...(t.stockKind ? [pbInt(9, t.stockKind)] : [])]);
		db.prepare('INSERT INTO notetypes VALUES (?, ?, 0, -1, ?)').run(t.id, t.name, cfg);
		t.fields.forEach((name, ord) => db.prepare('INSERT INTO fields VALUES (?, ?, ?, ?)').run(t.id, ord, name, pbString(3, 'Arial')));
		t.templates.forEach((tm, ord) =>
			// Template.Config: q_format = 1, a_format = 2
			db.prepare('INSERT INTO templates VALUES (?, ?, ?, 0, -1, ?)').run(t.id, ord, tm.name, Buffer.concat([pbString(1, tm.q), pbString(2, tm.a)]))
		);
	}
	// Deck.KindContainer: normal = 1 { config_id = 1 }; names use \x1f between levels.
	const normal = (configId) => pbBytes(1, pbInt(1, configId));
	db.prepare('INSERT INTO decks VALUES (?, ?, 0, -1, ?, ?)').run(DECK.default, 'Default', Buffer.alloc(0), normal(1));
	db.prepare('INSERT INTO decks VALUES (?, ?, 0, -1, ?, ?)').run(DECK.biochem, 'MCAT\u001fBiochemistry', Buffer.alloc(0), normal(1700000000301));
	db.prepare('INSERT INTO decks VALUES (?, ?, 0, -1, ?, ?)').run(DECK.physics, 'MCAT\u001fChem-Phys', Buffer.alloc(0), normal(1700000000301));
	// DeckConfig.Config: new_per_day = 9, leech_threshold = 22, desired_retention = 37
	db.prepare('INSERT INTO deck_config VALUES (?, ?, 0, -1, ?)').run(1, 'Default', Buffer.concat([pbInt(9, 20), pbInt(22, 8), pbFloat(37, 0.9)]));
	db.prepare('INSERT INTO deck_config VALUES (?, ?, 0, -1, ?)').run(1700000000301, 'MCAT preset', Buffer.concat([pbInt(9, 30), pbInt(22, 8), pbFloat(37, retention)]));
	db.prepare('INSERT INTO tags VALUES (?, -1, 0, NULL)').run('MCAT::Biochem');
	fillNotesCardsRevlog(db, content);
	// Real Anki declares its own "unicase" collation on these name columns, which
	// SQLite only knows inside Anki. Written as nocase above, then renamed here.
	db.unsafeMode(true);
	db.pragma('writable_schema = ON');
	db.prepare(`UPDATE sqlite_master SET sql = replace(sql, 'COLLATE nocase', 'COLLATE unicase') WHERE sql LIKE '%COLLATE nocase%'`).run();
	db.pragma('writable_schema = OFF');
	db.close();
}

function zipTo(file, entries) {
	return new Promise((resolve, reject) => {
		const zip = new yazl.ZipFile();
		for (const [name, buf] of entries) zip.addBuffer(buf, name);
		zip.end();
		zip.outputStream.pipe(fs.createWriteStream(file)).on('close', resolve).on('error', reject);
	});
}

/**
 * Writes an .apkg. options: { format: 'legacy' | 'latest', variant: 'v1' | 'v2' | 'v3' | 'nohistory', retention, withMedia }
 */
export async function makeAnkiPackage(file, options = {}) {
	const format = options.format ?? 'legacy';
	const variant = options.variant ?? 'v1';
	const retention = options.retention ?? 0.85;
	const withMedia = options.withMedia ?? true;
	const content = deckContent(variant);
	const types = variant === 'clash' ? noteTypes.map((t) => (t.id === NT.basic ? clashingBasic : t)) : noteTypes;
	const work = fs.mkdtempSync(path.join(path.dirname(file), 'mk-'));
	const colFile = path.join(work, 'collection.sqlite');
	const mediaNames = withMedia ? Object.keys(content.media) : [];
	const entries = [];
	if (format === 'legacy') {
		legacyCollection(colFile, content, retention, types);
		entries.push(['collection.anki21', fs.readFileSync(colFile)]);
		entries.push(['media', Buffer.from(JSON.stringify(Object.fromEntries(mediaNames.map((n, i) => [String(i), n]))))]);
		mediaNames.forEach((n, i) => entries.push([String(i), content.media[n]]));
	} else {
		latestCollection(colFile, content, retention, types);
		entries.push(['collection.anki2', Buffer.from('placeholder for old Anki versions')]);
		entries.push(['collection.anki21b', zlib.zstdCompressSync(fs.readFileSync(colFile))]);
		entries.push(['meta', pbInt(1, 3)]);
		const list = Buffer.concat(
			mediaNames.map((n) => pbBytes(1, Buffer.concat([pbString(1, n), pbInt(2, content.media[n].length), pbBytes(3, createHash('sha1').update(content.media[n]).digest())])))
		);
		entries.push(['media', zlib.zstdCompressSync(list)]);
		mediaNames.forEach((n, i) => entries.push([String(i), zlib.zstdCompressSync(content.media[n])]));
	}
	await zipTo(file, entries);
	fs.rmSync(work, { recursive: true, force: true });
	return { file, content };
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
	const out = process.argv[2] ?? 'tests/.tmp/anki';
	fs.mkdirSync(out, { recursive: true });
	for (const [name, opts] of [
		['mcat-legacy.apkg', { format: 'legacy' }],
		['mcat-latest-v2.apkg', { format: 'latest', variant: 'v2' }],
		['mcat-nohistory.apkg', { format: 'legacy', variant: 'nohistory' }]
	]) {
		await makeAnkiPackage(path.join(out, name), opts);
		console.log('wrote', path.join(out, name));
	}
}
