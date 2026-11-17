import { deviceId } from './device';

// Counts active study time on a page: the tab is visible and the owner did
// something in the last two minutes. Reports every 30 seconds.

const IDLE_MS = 2 * 60_000;
const BEAT_MS = 30_000;

export function trackActivity(activity: 'review' | 'reading' | 'mistakes' | 'practice', documentId?: () => string | null) {
	let lastInput = Date.now();
	let active = 0;
	let lastTick = Date.now();

	const onInput = () => {
		lastInput = Date.now();
	};
	const events = ['pointerdown', 'keydown', 'wheel', 'scroll', 'touchstart'];
	for (const e of events) window.addEventListener(e, onInput, { passive: true, capture: true });

	const tick = () => {
		const now = Date.now();
		const elapsed = now - lastTick;
		lastTick = now;
		if (document.visibilityState === 'visible' && now - lastInput < IDLE_MS) active += elapsed;
	};

	const flush = (useBeacon = false) => {
		tick();
		const seconds = Math.round(active / 1000);
		if (seconds < 5) return;
		active = 0;
		const body = JSON.stringify({ activity, seconds, documentId: documentId?.() ?? null, deviceId: deviceId() });
		if (useBeacon && navigator.sendBeacon) {
			navigator.sendBeacon('/api/activity', new Blob([body], { type: 'application/json' }));
		} else {
			void fetch('/api/activity', { method: 'POST', headers: { 'content-type': 'application/json' }, body }).catch(() => {});
		}
	};

	const timer = setInterval(() => flush(), BEAT_MS);
	const second = setInterval(tick, 5000);
	const onHide = () => {
		if (document.visibilityState === 'hidden') flush(true);
	};
	document.addEventListener('visibilitychange', onHide);

	return () => {
		flush(true);
		clearInterval(timer);
		clearInterval(second);
		document.removeEventListener('visibilitychange', onHide);
		for (const e of events) window.removeEventListener(e, onInput, { capture: true } as EventListenerOptions);
	};
}
