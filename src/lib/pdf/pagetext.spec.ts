import { describe, expect, it } from 'vitest';
import { buildPageText, rectsForRange } from './pagetext.js';

const viewport = { transform: [1, 0, 0, -1, 0, 792], width: 612, height: 792 };

function item(str: string, x: number, y: number, width: number, eol = false) {
	return { str, transform: [11, 0, 0, 11, x, y], width, height: 11, fontName: 'f', hasEOL: eol };
}

describe('page text', () => {
	it('joins runs with spaces and line breaks, keeping one run per item', () => {
		const { text, runs } = buildPageText(
			[item('Enzymes lower', 72, 700, 70), item('activation', 150, 700, 50, true), item('energy.', 72, 685, 40)],
			viewport
		);
		expect(text).toBe('Enzymes lower activation\nenergy.');
		expect(runs).toHaveLength(3);
		expect(text.slice(runs[1][0], runs[1][1])).toBe('activation');
		expect(text.slice(runs[2][0], runs[2][1])).toBe('energy.');
	});

	it('maps a character range to boxes on the page', () => {
		const { runs } = buildPageText([item('Enzymes lower', 72, 700, 70)], viewport);
		const [r] = rectsForRange(runs, 0, 7);
		expect(r[0]).toBeCloseTo(72 / 612, 3);
		expect(r[2]).toBeLessThan((72 + 70) / 612);
		expect(r[1]).toBeLessThan(r[3]);
	});
});
