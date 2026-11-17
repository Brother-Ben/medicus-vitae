// A soft chime for the focus timer, made with Web Audio (no sound files).
// bell: a warm struck bell; soft: two gentle sine tones; wood: a short wooden knock.

import type { ChimeSound } from '#lib/focus.js';

let ctx: AudioContext | null = null;

function audio(): AudioContext | null {
	if (typeof window === 'undefined') return null;
	try {
		ctx ??= new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
		if (ctx.state === 'suspended') void ctx.resume();
		return ctx;
	} catch {
		return null;
	}
}

/** Browsers only allow sound after a click: call this from a click so later chimes can play. */
export function unlockAudio() {
	audio();
}

function tone(c: AudioContext, freq: number, start: number, length: number, peak: number, type: OscillatorType = 'sine') {
	const osc = c.createOscillator();
	const gain = c.createGain();
	osc.type = type;
	osc.frequency.value = freq;
	gain.gain.setValueAtTime(0.0001, start);
	gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + 0.015);
	gain.gain.exponentialRampToValueAtTime(0.0001, start + length);
	osc.connect(gain).connect(c.destination);
	osc.start(start);
	osc.stop(start + length + 0.05);
}

/** Plays the chime. `rising`: a focus phase starting (two notes up); otherwise a break starting (two notes down). */
export function chime(sound: ChimeSound, volume: number, rising = false) {
	const c = audio();
	if (!c || volume <= 0) return;
	const v = Math.min(1, volume) * 0.35;
	const t = c.currentTime + 0.02;
	if (sound === 'bell') {
		const notes = rising ? [523.25, 783.99] : [783.99, 523.25];
		notes.forEach((f, i) => {
			const at = t + i * 0.45;
			// A bell: a fundamental with softer inharmonic partials that fade faster.
			tone(c, f, at, 2.6, v);
			tone(c, f * 2.76, at, 1.2, v * 0.25);
			tone(c, f * 5.4, at, 0.6, v * 0.1);
		});
	} else if (sound === 'soft') {
		const notes = rising ? [440, 554.37] : [554.37, 440];
		notes.forEach((f, i) => tone(c, f, t + i * 0.5, 1.8, v * 0.8));
	} else {
		const notes = rising ? [600, 900] : [900, 600];
		notes.forEach((f, i) => tone(c, f, t + i * 0.22, 0.18, v, 'triangle'));
	}
}
