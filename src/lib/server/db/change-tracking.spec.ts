import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// Every owner-data table must bump instance.write_seq, or snapshots and the
// primary/standby divergence check would miss changes to it.
describe('change tracking', () => {
	it('has write_seq triggers for every table except instance', () => {
		const dir = path.join(process.cwd(), 'drizzle');
		const sql = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
		const tables = [...sql.matchAll(/CREATE TABLE `([a-z_]+)`/g)].map((x) => x[1]).filter((t) => t !== 'instance');
		const missing = tables.filter((t) => !['i', 'u', 'd'].every((s) => sql.includes(`ws_${t}_${s}`)));
		expect(missing).toEqual([]);
	});
});
