// Today's study session in the browser: the session bar, the break screen and
// the session page all read this. The server keeps the truth (so a reload or a
// second tab agrees); this ticks the clock, notices when a phase ends, and plays
// the chime.

import { api } from '#lib/client/api.js';
import { chime } from '#lib/client/chime.js';
import { toastError } from '#lib/client/toast.svelte.js';
import { DEFAULT_FOCUS, timeLeft, type FocusPrefs, type TimerState } from '#lib/focus.js';
import type { SessionView, TimerAction } from '#lib/server/planner.js';

type TimerActionName = TimerAction;

export const live = $state({
	plan: null as SessionView | null,
	prefs: { ...DEFAULT_FOCUS } as FocusPrefs,
	now: Date.now(),
	/** The break screen was put away for this break. */
	breakHidden: false,
	busy: false
});

let ticker: ReturnType<typeof setInterval> | null = null;
let lastPhaseKey = '';
let asking = false;

function phaseKey(t: TimerState | null) {
	return t ? `${t.phase}:${t.phaseStartedAt}` : '';
}

/** Called by the app shell whenever fresh data arrives from the server. */
export function syncSession(plan: SessionView | null, prefs: FocusPrefs) {
	live.prefs = prefs;
	setPlan(plan, false);
	if (typeof window !== 'undefined' && !ticker) {
		ticker = setInterval(tick, 1000);
		document.addEventListener('visibilitychange', () => {
			if (!document.hidden) tick();
		});
	}
}

function setPlan(plan: SessionView | null, fromAction: boolean) {
	const before = live.plan?.timer ?? null;
	live.plan = plan && plan.status === 'active' ? plan : null;
	const t = live.plan?.timer ?? null;
	const key = phaseKey(t);
	if (key !== lastPhaseKey) {
		// A new phase: chime (not on the first load of the page), and show the break screen again.
		if (lastPhaseKey && t && before && live.prefs.chime && (t.phase !== before.phase || t.phaseStartedAt !== before.phaseStartedAt)) {
			if (t.phase === 'break' || t.phase === 'ready-break') chime(live.prefs.chimeSound, live.prefs.chimeVolume, false);
			else if (t.phase === 'focus' && before.phase !== 'ready-focus' && !fromAction) chime(live.prefs.chimeSound, live.prefs.chimeVolume, true);
			else if (t.phase === 'ready-focus') chime(live.prefs.chimeSound, live.prefs.chimeVolume, true);
		}
		if (t && (t.phase === 'break' || t.phase === 'ready-break' || t.phase === 'ready-focus')) live.breakHidden = false;
		lastPhaseKey = key;
	}
}

function tick() {
	live.now = Date.now();
	const plan = live.plan;
	const t = plan?.timer;
	if (!plan || !t || asking) return;
	if ((t.phase === 'focus' || t.phase === 'break') && !t.pausedAt && timeLeft(t, live.now) <= 0) {
		asking = true;
		void api<{ plan: SessionView }>(`/api/session/${plan.id}`, { body: { timer: 'next-phase' } })
			.then((r) => setPlan(r.plan, false))
			.catch(() => {})
			.finally(() => (asking = false));
	}
}

async function send(body: Record<string, unknown>) {
	const plan = live.plan;
	if (!plan) return null;
	live.busy = true;
	try {
		const r = await api<{ plan: SessionView }>(`/api/session/${plan.id}`, { body });
		setPlan(r.plan, true);
		return r.plan;
	} catch (err) {
		toastError(err);
		return null;
	} finally {
		live.busy = false;
	}
}

export function timer(action: TimerActionName, minutes?: number) {
	return send({ timer: action, minutes });
}

export function markItem(itemId: string, done: boolean) {
	return send({ itemId, done });
}

export function editLive(edit: Record<string, unknown>) {
	return send(edit);
}

export async function endLive() {
	const plan = live.plan;
	if (!plan) return;
	await send({ end: true });
	live.plan = null;
	lastPhaseKey = '';
}

/** Seconds left in the timer's phase right now. */
export function liveTimeLeft(): number {
	const t = live.plan?.timer;
	return t ? timeLeft(t, live.now) : 0;
}

/** The item being worked on. */
export function currentItem() {
	const p = live.plan;
	return p ? (p.items.find((i) => i.id === p.currentItemId) ?? null) : null;
}

/** Wall-clock time, e.g. "3:42 PM". */
export function wallClock(ms: number, format: '12h' | '24h') {
	return new Date(ms).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: format === '12h' });
}
