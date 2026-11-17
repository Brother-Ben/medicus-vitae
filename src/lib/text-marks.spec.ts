import { describe, expect, it } from 'vitest';
import { addSpan, coversSpan, overlapsSpan, removeSpan, segments } from './text-marks';

describe('text highlights', () => {
	it('joins highlights that overlap or touch', () => {
		expect(addSpan([], [4, 9])).toEqual([[4, 9]]);
		expect(addSpan([[4, 9]], [7, 12])).toEqual([[4, 12]]);
		expect(addSpan([[4, 9]], [9, 12])).toEqual([[4, 12]]);
		expect(addSpan([[4, 9]], [20, 25])).toEqual([[4, 9], [20, 25]]);
		expect(addSpan([[20, 25]], [12, 4])).toEqual([[4, 12], [20, 25]]);
		expect(addSpan([[4, 9]], [6, 6])).toEqual([[4, 9]]);
	});

	it('unhighlights all, part, or the middle of a highlight', () => {
		expect(removeSpan([[4, 12]], [4, 12])).toEqual([]);
		expect(removeSpan([[4, 12]], [0, 30])).toEqual([]);
		expect(removeSpan([[4, 12]], [4, 8])).toEqual([[8, 12]]);
		expect(removeSpan([[4, 12]], [6, 9])).toEqual([[4, 6], [9, 12]]);
		expect(removeSpan([[4, 12], [20, 25]], [10, 22])).toEqual([[4, 10], [22, 25]]);
		expect(removeSpan([[4, 12]], [12, 20])).toEqual([[4, 12]]);
	});

	it('tells whether a selection is all or partly highlighted', () => {
		expect(coversSpan([[4, 12]], [5, 9])).toBe(true);
		expect(coversSpan([[4, 12]], [2, 9])).toBe(false);
		expect(coversSpan([[4, 8], [8, 12]], [5, 11])).toBe(true);
		expect(overlapsSpan([[4, 12]], [10, 20])).toBe(true);
		expect(overlapsSpan([[4, 12]], [12, 20])).toBe(false);
	});

	it('cuts a paragraph into plain and highlighted runs', () => {
		expect(segments('The author argues', [[4, 10]])).toEqual([
			{ text: 'The ', start: 0, end: 4, hl: false },
			{ text: 'author', start: 4, end: 10, hl: true },
			{ text: ' argues', start: 10, end: 17, hl: false }
		]);
		expect(segments('abc', undefined)).toEqual([{ text: 'abc', start: 0, end: 3, hl: false }]);
		expect(segments('abc', [[0, 3]])).toEqual([{ text: 'abc', start: 0, end: 3, hl: true }]);
		expect(segments('abc', [[1, 99]]).map((s) => s.text)).toEqual(['a', 'bc']);
		expect(segments('', [])).toEqual([{ text: '', start: 0, end: 0, hl: false }]);
	});
});
