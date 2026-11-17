import { describe, expect, it } from 'vitest';
import { toFtsQuery } from './search';

describe('search queries', () => {
	it('quotes words, keeps phrases, and prefix-matches the last word', () => {
		expect(toFtsQuery('michaelis menten')).toBe('"michaelis" "menten"*');
		expect(toFtsQuery('"competitive inhibitor" km')).toBe('"competitive inhibitor" "km"*');
	});

	it('neutralizes FTS syntax typed by the owner', () => {
		expect(toFtsQuery('NEAR( a OR b ) * -x')).toBe('"NEAR" "a" "OR" "b" "x"');
		expect(toFtsQuery('   ')).toBeNull();
	});
});
