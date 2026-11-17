// The first-time guide in the browser: whether it's open and which step shows.
// The step is kept for this tab (sessionStorage), so reloading a page mid-tour
// carries on where it was. Finishing or closing it is saved to the account, so
// it doesn't show by itself again on any device.

import { invalidate } from '$app/navigation';
import type { GuideStepId } from '#lib/guide.js';

export const guide = $state({
	open: false,
	step: 0,
	/** Starts with the welcome card (the first time); from Settings it goes straight to the first tab. */
	welcome: true,
	/** The step showing now, for the menu to point at its tab. */
	current: null as GuideStepId | null,
	/** Set by Next, Back and starting the tour: the card then opens that step's page (a reload or wandering off doesn't). */
	move: false
});

const KEY = 'mv-guide';
/** Offered once per page load at most, whatever the saved state says. */
let offered = false;

function save() {
	try {
		if (guide.open) sessionStorage.setItem(KEY, JSON.stringify({ step: guide.step, welcome: guide.welcome }));
		else sessionStorage.removeItem(KEY);
	} catch {
		// Storage unavailable: the tour still works, it just won't survive a reload.
	}
}

export function startGuide(opts: { welcome: boolean }) {
	offered = true;
	guide.welcome = opts.welcome;
	guide.step = 0;
	guide.open = true;
	guide.move = true;
	save();
}

export function setGuideStep(step: number) {
	guide.step = step;
	guide.move = true;
	save();
}

/** A tour left open before a reload. */
export function resumeGuide(): boolean {
	if (guide.open) return true;
	try {
		const saved = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as { step?: number; welcome?: boolean } | null;
		if (!saved) return false;
		offered = true;
		guide.welcome = saved.welcome !== false;
		guide.step = Math.max(0, Math.floor(Number(saved.step) || 0));
		guide.open = true;
		return true;
	} catch {
		return false;
	}
}

/** Whether the tour should open by itself: never seen on this account, and not offered yet on this page load. */
export function shouldOfferGuide(done: boolean): boolean {
	return !done && !offered && !guide.open;
}

/** Closes the tour (finished or skipped) and remembers that on the account. */
export async function closeGuide() {
	offered = true;
	guide.open = false;
	guide.current = null;
	save();
	try {
		await fetch('/api/guide', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ done: true }) });
		await invalidate('app:shell');
	} catch {
		// A standby copy can't save; the tour simply shows again there next time.
	}
}
