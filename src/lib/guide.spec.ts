import { describe, expect, it } from 'vitest';
import { NAV_ITEMS } from './appearance';
import { guideSteps } from './guide';

describe('first-time guide', () => {
	it('visits every tab once, in the menu’s order, then Settings', () => {
		const steps = guideSteps(['library', 'today', 'search']);
		expect(steps[0].id).toBe('welcome');
		expect(steps.map((s) => s.id).slice(1, 4)).toEqual(['library', 'today', 'search']);
		expect(steps.at(-1)!.id).toBe('settings');
		const tabs = steps.filter((s) => s.id !== 'welcome' && s.id !== 'settings').map((s) => s.id);
		expect([...tabs].sort()).toEqual(NAV_ITEMS.map((n) => n.id).sort());
		expect(guideSteps([], { welcome: false })[0].id).toBe('today');
	});

	it('opens each tab’s own page', () => {
		for (const s of guideSteps(NAV_ITEMS.map((n) => n.id))) {
			if (s.id === 'welcome') expect(s.href).toBeNull();
			else if (s.id === 'settings') expect(s.href).toBe('/settings');
			else expect(s.href).toBe(NAV_ITEMS.find((n) => n.id === s.id)!.href);
		}
	});

	it('keeps to plain words, with no technical or AI terms', () => {
		// "Settings › AI" names the settings section; nothing else may say AI.
		const banned = [/(?<!› )\bAI\b/, /\bLLM\b/i, /\bmodels?\b/i, /\bprompt/i, /\bgenerat/i, /\bembedding/i, /\bsemantic/i, /\balgorithm/i, /\bFSRS\b/i, /\bretriev/i, /\btokens?\b/i, /\bAPI\b/, /\bprovider/i, /\bsuspend/i];
		for (const s of guideSteps(NAV_ITEMS.map((n) => n.id))) {
			for (const text of [s.title, s.intro, ...s.points.flat()]) {
				for (const word of banned) expect(text, `${s.id}: ${text}`).not.toMatch(word);
			}
			expect(s.points.length).toBeLessThanOrEqual(7);
		}
	});
});
