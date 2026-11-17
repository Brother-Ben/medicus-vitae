// Writes drizzle/0001_search_index_and_change_tracking.sql: the FTS5 search
// index, the built-in note types, and write_seq triggers on every owner-data
// table (all tables in 0000_init.sql except `instance`).
//
//   node scripts/gen-change-tracking.cjs
//
// Run after `drizzle-kit generate --custom --name search_index_and_change_tracking`
// created the empty file. New tables added in later migrations need their own
// triggers (see src/lib/server/db/change-tracking.spec.ts, which checks this).

const fs = require('node:fs');
const path = require('node:path');

const dir = path.join(__dirname, '..', 'drizzle');
const init = fs.readFileSync(path.join(dir, '0000_init.sql'), 'utf8');
const tables = [...init.matchAll(/CREATE TABLE `([a-z_]+)`/g)].map((m) => m[1]).filter((t) => t !== 'instance');

const parts = [];
parts.push(`-- Keyword search across book pages, annotations and cards (LIB-03). Stemmed English.
CREATE VIRTUAL TABLE \`search_index\` USING fts5(
	\`body\`,
	\`kind\` UNINDEXED,
	\`ref_id\` UNINDEXED,
	\`doc_id\` UNINDEXED,
	\`page\` UNINDEXED,
	tokenize = 'porter unicode61 remove_diacritics 2'
);`);
parts.push(`-- Built-in Anki-compatible note types.
INSERT INTO \`note_type\` (\`id\`, \`name\`, \`kind\`, \`fields\`, \`templates\`, \`builtin\`, \`created_at\`) VALUES
	('nt-basic', 'Basic', 'basic', '["Front","Back"]', '[{"name":"Card 1","front":"{{Front}}","back":"{{FrontSide}}<hr id=answer>{{Back}}"}]', 1, 0),
	('nt-basic-reversed', 'Basic (and reversed card)', 'basic_reversed', '["Front","Back"]', '[{"name":"Card 1","front":"{{Front}}","back":"{{FrontSide}}<hr id=answer>{{Back}}"},{"name":"Card 2","front":"{{Back}}","back":"{{FrontSide}}<hr id=answer>{{Front}}"}]', 1, 0),
	('nt-cloze', 'Cloze', 'cloze', '["Text","Back Extra"]', '[{"name":"Cloze","front":"{{cloze:Text}}","back":"{{cloze:Text}}<br>{{Back Extra}}"}]', 1, 0);`);
const header = `-- Change counter: every write to owner data bumps instance.write_seq, so snapshots
-- can be skipped when nothing changed and a returning device can tell whether it
-- holds changes its peer never saw (spec Section 11).\n`;
tables.forEach((t, i) => {
	for (const [op, suffix] of [
		['INSERT', 'i'],
		['UPDATE', 'u'],
		['DELETE', 'd']
	]) {
		const stmt = `CREATE TRIGGER \`ws_${t}_${suffix}\` AFTER ${op} ON \`${t}\` BEGIN UPDATE \`instance\` SET \`write_seq\` = \`write_seq\` + 1; END;`;
		parts.push(i === 0 && suffix === 'i' ? header + stmt : stmt);
	}
});
fs.writeFileSync(path.join(dir, '0001_search_index_and_change_tracking.sql'), parts.join('\n--> statement-breakpoint\n') + '\n');
console.log(`Triggers for ${tables.length} tables: ${tables.join(', ')}`);
