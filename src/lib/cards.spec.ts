import { describe, expect, it } from 'vitest';
import { cardOrds, clozeNumbers, noteProblem, notePreview, noteText } from './cards';
import { renderCardSide, renderMarkdown } from './markdown';

describe('cards', () => {
	const cloze = { Text: 'A {{c1::competitive}} inhibitor raises {{c2::Km::a constant}} but not {{c1::Vmax}}.', 'Back Extra': '' };

	it('makes one card per cloze number', () => {
		expect(clozeNumbers(cloze.Text)).toEqual([1, 2]);
		expect(cardOrds('cloze', cloze)).toEqual([0, 1]);
		expect(cardOrds('basic', { Front: 'q', Back: 'a' })).toEqual([0]);
		expect(cardOrds('basic_reversed', { Front: 'q', Back: 'a' })).toEqual([0, 1]);
	});

	it('hides only the active deletion, with its hint', () => {
		const front1 = renderCardSide('cloze', cloze, 0, 'front');
		expect(front1).toContain('<span class="cloze">[…]</span> inhibitor raises Km but not <span class="cloze">[…]</span>');
		const front2 = renderCardSide('cloze', cloze, 1, 'front');
		expect(front2).toContain('A competitive inhibitor raises <span class="cloze">[a constant]</span>');
		const back2 = renderCardSide('cloze', cloze, 1, 'back');
		expect(back2).toContain('<span class="cloze">Km</span>');
	});

	it('swaps sides for the reverse card', () => {
		const f = { Front: 'Km', Back: 'Substrate concentration at half Vmax' };
		expect(renderCardSide('basic_reversed', f, 1, 'front')).toContain('Substrate concentration');
		expect(renderCardSide('basic_reversed', f, 1, 'back')).toContain('Km');
	});

	it('never passes raw HTML or script links through', () => {
		const html = renderMarkdown('<img src=x onerror=alert(1)> [x](javascript:alert(1)) **ok**');
		expect(html).not.toContain('<img');
		expect(html).not.toContain('javascript:');
		expect(html).toContain('<strong>ok</strong>');
	});

	it('reports empty or cloze-less notes', () => {
		expect(noteProblem('basic', { Front: '', Back: 'x' })).toMatch(/front/i);
		expect(noteProblem('cloze', { Text: 'no deletions here' })).toMatch(/deletion/i);
		expect(noteProblem('cloze', cloze)).toBeNull();
	});

	it('produces plain text for search and previews', () => {
		expect(noteText('cloze', cloze)).toBe('A competitive inhibitor raises Km but not Vmax.');
		expect(notePreview('cloze', cloze)).toBe('A [competitive] inhibitor raises [Km] but not [Vmax].');
	});
});
