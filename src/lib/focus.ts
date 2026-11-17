// Focus timer (Pomodoro) and break settings, shared by server and browser.
// Saved with the account (user.study_prefs); every value has a default.

export type BreathPattern = 'box' | '478' | 'calm';
export type BreakActivity = 'breathing' | 'prompts' | 'meditation' | 'mix';
export type MeditationScript = 'body-scan' | 'grounding' | 'breath-count';
export type PromptKind = 'relax' | 'eyes' | 'water' | 'stretch' | 'posture';
export type ChimeSound = 'bell' | 'soft' | 'wood';

export interface FocusPrefs {
	/** Use the focus timer when a session starts (it can still be switched per session). */
	useTimer: boolean;
	focusMinutes: number;
	shortBreakMinutes: number;
	longBreakMinutes: number;
	/** Focus rounds before a long break. */
	roundsBeforeLong: number;
	autoStartBreaks: boolean;
	autoStartFocus: boolean;
	/** What a break opens with (you can switch during the break). */
	breakActivity: BreakActivity;
	breathing: boolean;
	breathPattern: BreathPattern;
	prompts: boolean;
	promptKinds: Record<PromptKind, boolean>;
	meditation: boolean;
	meditationScript: MeditationScript;
	chime: boolean;
	chimeSound: ChimeSound;
	/** 0–1 */
	chimeVolume: number;
	/** The clock in the session bar: 12- or 24-hour. */
	clock: '12h' | '24h';
	/** Minute choices offered when planning a session. */
	presets: number[];
}

export const DEFAULT_FOCUS: FocusPrefs = {
	useTimer: true,
	focusMinutes: 25,
	shortBreakMinutes: 5,
	longBreakMinutes: 15,
	roundsBeforeLong: 4,
	autoStartBreaks: true,
	autoStartFocus: false,
	breakActivity: 'breathing',
	breathing: true,
	breathPattern: 'box',
	prompts: true,
	promptKinds: { relax: true, eyes: true, water: true, stretch: true, posture: true },
	meditation: true,
	meditationScript: 'grounding',
	chime: true,
	chimeSound: 'bell',
	chimeVolume: 0.5,
	clock: '12h',
	presets: [15, 25, 30, 45, 60, 90]
};

export const BREATH_PATTERNS: { id: BreathPattern; name: string; detail: string; steps: { label: string; seconds: number; scale: number }[] }[] = [
	{
		id: 'box',
		name: 'Box breathing',
		detail: 'In 4, hold 4, out 4, hold 4. Steadies you before the next round.',
		steps: [
			{ label: 'Breathe in', seconds: 4, scale: 1 },
			{ label: 'Hold', seconds: 4, scale: 1 },
			{ label: 'Breathe out', seconds: 4, scale: 0.55 },
			{ label: 'Hold', seconds: 4, scale: 0.55 }
		]
	},
	{
		id: '478',
		name: '4-7-8',
		detail: 'In 4, hold 7, out slowly for 8. Good for winding down stress.',
		steps: [
			{ label: 'Breathe in', seconds: 4, scale: 1 },
			{ label: 'Hold', seconds: 7, scale: 1 },
			{ label: 'Breathe out slowly', seconds: 8, scale: 0.55 }
		]
	},
	{
		id: 'calm',
		name: 'Slow breathing',
		detail: 'In 4, out 6. Simple and calming.',
		steps: [
			{ label: 'Breathe in', seconds: 4, scale: 1 },
			{ label: 'Breathe out', seconds: 6, scale: 0.55 }
		]
	}
];

export const PROMPT_KINDS: { id: PromptKind; name: string }[] = [
	{ id: 'relax', name: 'Relax and unclench' },
	{ id: 'eyes', name: 'Rest your eyes' },
	{ id: 'water', name: 'Drink water' },
	{ id: 'stretch', name: 'Stretch' },
	{ id: 'posture', name: 'Posture' }
];

export const PROMPTS: Record<PromptKind, string[]> = {
	relax: [
		'Drop your shoulders away from your ears.',
		'Unclench your jaw and let your tongue rest.',
		'Take one slow breath, longer out than in.',
		'Notice your hands. Let them go soft.',
		'You did a full round. That counts.'
	],
	eyes: [
		'Look at something about 20 feet away for 20 seconds.',
		'Close your eyes and let them rest for a few breaths.',
		'Look out a window if you can. Let your focus go wide.'
	],
	water: ['Have a few sips of water.', 'Refill your water if it’s low.'],
	stretch: [
		'Stand up and reach your arms overhead.',
		'Roll your neck slowly, one way and then the other.',
		'Stretch your wrists and fingers.',
		'Take a short walk, even just across the room.'
	],
	posture: ['Sit back, feet flat, screen at eye level.', 'Check your back: let it lengthen a little.']
};

export const MEDITATIONS: { id: MeditationScript; name: string; steps: string[] }[] = [
	{
		id: 'grounding',
		name: '5-4-3-2-1 grounding',
		steps: [
			'Sit comfortably. Let your breath slow down.',
			'Notice five things you can see around you.',
			'Notice four things you can feel: your feet, the chair, your clothes, the air.',
			'Notice three things you can hear.',
			'Notice two things you can smell, or two scents you like.',
			'Notice one thing you can taste, or take a sip of water.',
			'Take one more slow breath. You’re here, and ready for the next round.'
		]
	},
	{
		id: 'body-scan',
		name: 'Quick body scan',
		steps: [
			'Close your eyes or lower your gaze.',
			'Bring your attention to your forehead and eyes. Let them soften.',
			'Move to your jaw and neck. Let them loosen.',
			'Your shoulders and arms: let them get heavy.',
			'Your chest and belly: let each breath move them gently.',
			'Your legs and feet: feel them resting, supported.',
			'Take a full breath in, and let it all go on the way out.'
		]
	},
	{
		id: 'breath-count',
		name: 'Counting breaths',
		steps: [
			'Sit tall and breathe normally.',
			'Count each breath out: one…',
			'two… three… four…',
			'up to ten. If your mind wanders, start again at one. That’s the whole practice.',
			'Keep counting, slowly and gently.',
			'Let the counting go, and just breathe for a moment.'
		]
	}
];

const clampInt = (v: unknown, lo: number, hi: number, d: number) => {
	const n = Math.round(Number(v));
	return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
};
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const pick = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d);

export function cleanFocus(v: unknown): FocusPrefs {
	const f = (v && typeof v === 'object' ? v : {}) as Partial<FocusPrefs>;
	const d = DEFAULT_FOCUS;
	const kinds = (f.promptKinds && typeof f.promptKinds === 'object' ? f.promptKinds : {}) as Partial<Record<PromptKind, unknown>>;
	const presets = Array.isArray(f.presets)
		? [...new Set(f.presets.map((x) => Math.round(Number(x))).filter((x) => Number.isFinite(x) && x >= 5 && x <= 600))].sort((a, b) => a - b).slice(0, 8)
		: d.presets;
	return {
		useTimer: bool(f.useTimer, d.useTimer),
		focusMinutes: clampInt(f.focusMinutes, 5, 180, d.focusMinutes),
		shortBreakMinutes: clampInt(f.shortBreakMinutes, 1, 60, d.shortBreakMinutes),
		longBreakMinutes: clampInt(f.longBreakMinutes, 1, 90, d.longBreakMinutes),
		roundsBeforeLong: clampInt(f.roundsBeforeLong, 1, 12, d.roundsBeforeLong),
		autoStartBreaks: bool(f.autoStartBreaks, d.autoStartBreaks),
		autoStartFocus: bool(f.autoStartFocus, d.autoStartFocus),
		breakActivity: pick(f.breakActivity, ['breathing', 'prompts', 'meditation', 'mix'] as const, d.breakActivity),
		breathing: bool(f.breathing, d.breathing),
		breathPattern: pick(f.breathPattern, ['box', '478', 'calm'] as const, d.breathPattern),
		prompts: bool(f.prompts, d.prompts),
		promptKinds: {
			relax: bool(kinds.relax, true),
			eyes: bool(kinds.eyes, true),
			water: bool(kinds.water, true),
			stretch: bool(kinds.stretch, true),
			posture: bool(kinds.posture, true)
		},
		meditation: bool(f.meditation, d.meditation),
		meditationScript: pick(f.meditationScript, ['body-scan', 'grounding', 'breath-count'] as const, d.meditationScript),
		chime: bool(f.chime, d.chime),
		chimeSound: pick(f.chimeSound, ['bell', 'soft', 'wood'] as const, d.chimeSound),
		chimeVolume: Math.min(1, Math.max(0, Number.isFinite(Number(f.chimeVolume)) ? Number(f.chimeVolume) : d.chimeVolume)),
		clock: pick(f.clock, ['12h', '24h'] as const, d.clock),
		presets: presets.length ? presets : d.presets
	};
}

// ------------------------------------------------------------ the timer

/** Timer settings a session runs with (copied from the prefs when it starts, editable per session). */
export interface SessionFocus {
	focusMinutes: number;
	shortBreakMinutes: number;
	longBreakMinutes: number;
	roundsBeforeLong: number;
	autoStartBreaks: boolean;
	autoStartFocus: boolean;
}

export type TimerPhase = 'focus' | 'break' | 'ready-focus' | 'ready-break' | 'done';

/** Where a session's timer is. Times in ms; the phase's time left is worked out from these. */
export interface TimerState {
	phase: TimerPhase;
	/** short | long, for a break (or a break that is ready to start). */
	breakKind: 'short' | 'long' | null;
	/** Focus rounds finished so far. */
	rounds: number;
	phaseStartedAt: number;
	/** Length of the current phase in seconds (extended with +1 / +5 min). */
	phaseSeconds: number;
	pausedAt: number | null;
	/** Paused time within this phase, ms. */
	pausedMs: number;
	/** The plan item being worked on. */
	currentItemId: string | null;
	/** Total focused time so far (finished phases), seconds. */
	focusedSeconds: number;
}

export function sessionFocusFrom(p: FocusPrefs): SessionFocus {
	return {
		focusMinutes: p.focusMinutes,
		shortBreakMinutes: p.shortBreakMinutes,
		longBreakMinutes: p.longBreakMinutes,
		roundsBeforeLong: p.roundsBeforeLong,
		autoStartBreaks: p.autoStartBreaks,
		autoStartFocus: p.autoStartFocus
	};
}

export function cleanSessionFocus(v: unknown, base: SessionFocus = sessionFocusFrom(DEFAULT_FOCUS)): SessionFocus {
	const f = (v && typeof v === 'object' ? v : {}) as Partial<SessionFocus>;
	return {
		focusMinutes: clampInt(f.focusMinutes, 5, 180, base.focusMinutes),
		shortBreakMinutes: clampInt(f.shortBreakMinutes, 1, 60, base.shortBreakMinutes),
		longBreakMinutes: clampInt(f.longBreakMinutes, 1, 90, base.longBreakMinutes),
		roundsBeforeLong: clampInt(f.roundsBeforeLong, 1, 12, base.roundsBeforeLong),
		autoStartBreaks: bool(f.autoStartBreaks, base.autoStartBreaks),
		autoStartFocus: bool(f.autoStartFocus, base.autoStartFocus)
	};
}

/** Seconds left in the current phase at `now` (never below 0). */
export function timeLeft(t: TimerState, now: number): number {
	if (t.phase !== 'focus' && t.phase !== 'break') return 0;
	const paused = t.pausedMs + (t.pausedAt ? now - t.pausedAt : 0);
	const elapsed = (now - t.phaseStartedAt - paused) / 1000;
	return Math.max(0, Math.ceil(t.phaseSeconds - elapsed));
}

export function startTimer(f: SessionFocus, now: number, currentItemId: string | null): TimerState {
	return {
		phase: 'focus',
		breakKind: null,
		rounds: 0,
		phaseStartedAt: now,
		phaseSeconds: f.focusMinutes * 60,
		pausedAt: null,
		pausedMs: 0,
		currentItemId,
		focusedSeconds: 0
	};
}

function begin(t: TimerState, phase: 'focus' | 'break', seconds: number, now: number, breakKind: 'short' | 'long' | null): TimerState {
	return { ...t, phase, breakKind, phaseStartedAt: now, phaseSeconds: seconds, pausedAt: null, pausedMs: 0 };
}

/** The phase after the current one (when time runs out, or "Skip"). */
export function nextPhase(t: TimerState, f: SessionFocus, now: number): TimerState {
	if (t.phase === 'focus') {
		const focused = Math.max(0, t.phaseSeconds - timeLeft(t, now));
		const rounds = t.rounds + 1;
		const kind = rounds % f.roundsBeforeLong === 0 ? 'long' : 'short';
		const done = { ...t, rounds, focusedSeconds: t.focusedSeconds + focused };
		const seconds = (kind === 'long' ? f.longBreakMinutes : f.shortBreakMinutes) * 60;
		return f.autoStartBreaks ? begin(done, 'break', seconds, now, kind) : { ...begin(done, 'break', seconds, now, kind), phase: 'ready-break' };
	}
	if (t.phase === 'ready-break') return begin(t, 'break', t.phaseSeconds, now, t.breakKind);
	if (t.phase === 'break') {
		const seconds = f.focusMinutes * 60;
		return f.autoStartFocus ? begin(t, 'focus', seconds, now, null) : { ...begin(t, 'focus', seconds, now, null), phase: 'ready-focus' };
	}
	if (t.phase === 'ready-focus') return begin(t, 'focus', f.focusMinutes * 60, now, null);
	return t;
}

export function pauseTimer(t: TimerState, now: number): TimerState {
	return t.pausedAt || (t.phase !== 'focus' && t.phase !== 'break') ? t : { ...t, pausedAt: now };
}

export function resumeTimer(t: TimerState, now: number): TimerState {
	return t.pausedAt ? { ...t, pausedMs: t.pausedMs + (now - t.pausedAt), pausedAt: null } : t;
}

/** More time in this phase. */
export function extendTimer(t: TimerState, minutes: number): TimerState {
	return { ...t, phaseSeconds: Math.max(60, t.phaseSeconds + Math.round(minutes * 60)) };
}

export function cleanTimer(v: unknown): TimerState | null {
	if (!v || typeof v !== 'object') return null;
	const t = v as Partial<TimerState>;
	const phases: TimerPhase[] = ['focus', 'break', 'ready-focus', 'ready-break', 'done'];
	if (!phases.includes(t.phase as TimerPhase)) return null;
	return {
		phase: t.phase as TimerPhase,
		breakKind: t.breakKind === 'short' || t.breakKind === 'long' ? t.breakKind : null,
		rounds: Math.max(0, Math.floor(Number(t.rounds) || 0)),
		phaseStartedAt: Number(t.phaseStartedAt) || Date.now(),
		phaseSeconds: Math.max(0, Number(t.phaseSeconds) || 0),
		pausedAt: t.pausedAt ? Number(t.pausedAt) : null,
		pausedMs: Math.max(0, Number(t.pausedMs) || 0),
		currentItemId: typeof t.currentItemId === 'string' ? t.currentItemId : null,
		focusedSeconds: Math.max(0, Number(t.focusedSeconds) || 0)
	};
}

/** "12:05" or "12:05:09". */
export function clockLabel(seconds: number): string {
	const s = Math.max(0, Math.round(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	const mm = h ? String(m).padStart(2, '0') : String(m);
	return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}
