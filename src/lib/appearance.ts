// Appearance settings (Settings › Appearance) and how they resolve to what the
// page shows. Shared by the server (stores the account's settings), the browser
// (applies them live) and the boot script in app.html (applies them before the
// first paint; see appearance-boot.ts, which must give the same answers).

export type Season = 'spring' | 'summer' | 'fall' | 'winter';

export const SEASONS: { id: Season; name: string }[] = [
	{ id: 'spring', name: 'Spring' },
	{ id: 'summer', name: 'Summer' },
	{ id: 'fall', name: 'Fall' },
	{ id: 'winter', name: 'Winter' }
];

export const THEMES = [
	{ id: 'clinic-light', name: 'Clinic Light', bestFor: 'Daytime', dark: false, season: null },
	{ id: 'clinic-dark', name: 'Clinic Dark', bestFor: 'Evenings', dark: true, season: null },
	{ id: 'paper', name: 'Paper', bestFor: 'Long reading sessions', dark: false, season: null },
	{ id: 'midnight', name: 'Midnight', bestFor: 'Phones at night', dark: true, season: null },
	{ id: 'high-contrast', name: 'High contrast', bestFor: 'Maximum readability', dark: false, season: null },
	{ id: 'spring', name: 'Spring', bestFor: 'Fresh greens and blossom', dark: false, season: 'spring' },
	{ id: 'spring-night', name: 'Spring Night', bestFor: 'Spring evenings', dark: true, season: 'spring' },
	{ id: 'summer', name: 'Summer', bestFor: 'Sand and sea', dark: false, season: 'summer' },
	{ id: 'summer-night', name: 'Summer Night', bestFor: 'Warm nights', dark: true, season: 'summer' },
	{ id: 'fall', name: 'Fall', bestFor: 'Rust and amber', dark: false, season: 'fall' },
	{ id: 'fall-night', name: 'Fall Night', bestFor: 'Cozy evenings', dark: true, season: 'fall' },
	{ id: 'winter', name: 'Winter', bestFor: 'Crisp and cool', dark: false, season: 'winter' },
	{ id: 'winter-night', name: 'Winter Night', bestFor: 'Long nights', dark: true, season: 'winter' }
] as const;

export type ThemeId = (typeof THEMES)[number]['id'];

/** The day and night theme of each season. */
export const SEASON_THEMES: Record<Season, { day: ThemeId; night: ThemeId }> = {
	spring: { day: 'spring', night: 'spring-night' },
	summer: { day: 'summer', night: 'summer-night' },
	fall: { day: 'fall', night: 'fall-night' },
	winter: { day: 'winter', night: 'winter-night' }
};

/** Fall: September–November. Winter: December–February. Spring: March–May. Summer: June–August. */
export function seasonOfDate(date: Date): Season {
	const m = date.getMonth();
	if (m >= 8 && m <= 10) return 'fall';
	if (m === 11 || m <= 1) return 'winter';
	if (m <= 4) return 'spring';
	return 'summer';
}

/** The season a theme belongs to (null for the everyday themes). */
export function themeSeason(id: ThemeId): Season | null {
	return THEMES.find((t) => t.id === id)?.season ?? null;
}

export const PAGE_STYLES = [
	{ id: 'original', name: 'Original' },
	{ id: 'dimmed', name: 'Dimmed' },
	{ id: 'sepia', name: 'Sepia' },
	{ id: 'inverted', name: 'Inverted' }
] as const;

export type PageStyle = (typeof PAGE_STYLES)[number]['id'];

/** "Match theme": the book page style that suits each theme. */
export const PAGE_FOR_THEME: Record<ThemeId, PageStyle> = {
	'clinic-light': 'original',
	'clinic-dark': 'dimmed',
	paper: 'sepia',
	midnight: 'inverted',
	'high-contrast': 'original',
	spring: 'original',
	'spring-night': 'dimmed',
	summer: 'original',
	'summer-night': 'inverted',
	fall: 'sepia',
	'fall-night': 'dimmed',
	winter: 'original',
	'winter-night': 'inverted'
};

export const TEXT_SIZES = [
	{ id: 'small', name: 'Small', scale: 0.9 },
	{ id: 'default', name: 'Default', scale: 1 },
	{ id: 'large', name: 'Large', scale: 1.12 },
	{ id: 'larger', name: 'Larger', scale: 1.25 }
] as const;

export type TextSize = (typeof TEXT_SIZES)[number]['id'];

export const HOLIDAYS = [
	{ id: 'christmas', name: 'Christmas' },
	{ id: 'thanksgiving', name: 'Thanksgiving' },
	{ id: 'ramadan', name: 'Ramadan' }
] as const;

export type HolidayId = (typeof HOLIDAYS)[number]['id'];

/** The main menu (sidebar, and the tab bar on phones). Settings is always there and isn't listed. */
export const NAV_ITEMS = [
	{ id: 'today', label: 'Today', href: '/', icon: 'home' },
	{ id: 'library', label: 'Library', href: '/library', icon: 'book' },
	{ id: 'cards', label: 'Flashcards', short: 'Cards', href: '/cards', icon: 'cards' },
	{ id: 'mistakes', label: 'Mistake journal', short: 'Mistakes', href: '/mistakes', icon: 'journal' },
	{ id: 'tutor', label: 'Tutor', href: '/tutor', icon: 'sparkle' },
	{ id: 'progress', label: 'Progress', href: '/progress', icon: 'chart' },
	{ id: 'notes', label: 'Notes', href: '/notes', icon: 'note' },
	{ id: 'search', label: 'Search', href: '/search', icon: 'search' }
] as const;

export type NavId = (typeof NAV_ITEMS)[number]['id'];

/** Sections of the Today page, in their default order. Off by default: shown only when turned on. */
export const HOME_SECTIONS = [
	{ id: 'start', name: 'Start studying', hint: 'Due cards, your session, where you stopped reading', on: true },
	{ id: 'stats', name: 'Your numbers', hint: 'Due, this week, recall, last full-length, streak', on: true },
	{ id: 'workOn', name: 'What to work on', hint: 'A short list from your cards, mistakes and weak areas', on: true },
	{ id: 'cars', name: 'CARS passage of the day', hint: 'Today’s Jack Westin passage and your CARS numbers', on: true },
	{ id: 'queue', name: 'Due by deck', hint: 'Cards waiting in each deck, retests and leeches', on: false },
	{ id: 'weak', name: 'Weakest areas', hint: 'AAMC categories with the lowest scores lately', on: false },
	{ id: 'forecast', name: 'Coming up', hint: 'Cards due each day for the next week', on: false },
	{ id: 'history', name: 'Study time', hint: 'The last 14 days, and recent sessions', on: false },
	{ id: 'reading', name: 'Continue reading', hint: 'The book you opened last', on: false },
	{ id: 'coach', name: 'AI coach', hint: 'Weekly recap, suggestions, mistake patterns (needs AI)', on: false },
	{ id: 'tutor', name: 'Ask the tutor', hint: 'A question box for the tutor (needs AI)', on: false }
] as const;

export type HomeSectionId = (typeof HOME_SECTIONS)[number]['id'];

export interface LayoutItem<T extends string> {
	id: T;
	visible: boolean;
}

export const DEFAULT_NAV: LayoutItem<NavId>[] = NAV_ITEMS.map((n) => ({ id: n.id, visible: true }));
export const DEFAULT_HOME: LayoutItem<HomeSectionId>[] = HOME_SECTIONS.map((s) => ({ id: s.id, visible: s.on }));

/** A saved order: known ids in the saved order (no repeats), then any new ones at their default place. */
export function cleanLayout<T extends string>(v: unknown, defaults: LayoutItem<T>[]): LayoutItem<T>[] {
	const known = new Map(defaults.map((d) => [d.id, d]));
	const out: LayoutItem<T>[] = [];
	const seen = new Set<string>();
	if (Array.isArray(v)) {
		for (const raw of v) {
			const o = (raw && typeof raw === 'object' ? raw : {}) as { id?: unknown; visible?: unknown };
			const id = typeof o.id === 'string' ? o.id : '';
			if (!known.has(id as T) || seen.has(id)) continue;
			seen.add(id);
			out.push({ id: id as T, visible: typeof o.visible === 'boolean' ? o.visible : known.get(id as T)!.visible });
		}
	}
	defaults.forEach((d, i) => {
		if (seen.has(d.id)) return;
		// A section added in a later version goes after every section that comes before it in the defaults.
		const before = new Set(defaults.slice(0, i).map((x) => x.id));
		let at = 0;
		out.forEach((x, k) => {
			if (before.has(x.id)) at = k + 1;
		});
		out.splice(at, 0, { ...d });
		seen.add(d.id);
	});
	return out;
}

/**
 * How the theme is chosen: one theme, the device's light/dark setting, the time
 * of day, or the season of the year (with its day or night version).
 */
export interface ThemeChoice {
	mode: 'pick' | 'system' | 'time' | 'season';
	theme: ThemeId;
	lightTheme: ThemeId;
	darkTheme: ThemeId;
	/** 'HH:MM', 24-hour: the dark theme is used from darkFrom until darkTo. */
	darkFrom: string;
	darkTo: string;
	/** Season mode: day or night version always, or following the device or the time of day. */
	seasonShade: 'light' | 'dark' | 'system' | 'time';
}

/** Which season's decorations show (holidays still come first when they're on). */
export type DecorSeason = 'match' | 'calendar' | Season;

/** Saved with the account, so every device gets them (a device can override the theme choice). */
export interface AccountAppearance extends ThemeChoice {
	/** Book pages in the reader: match the theme, or a fixed style. */
	page: 'match' | PageStyle;
	sectionColors: boolean;
	/** While reviewing flashcards, only the card shows. */
	focusMode: boolean;
	textSize: TextSize;
	decorations: 'off' | 'seasons' | 'all';
	/** match: the season of a season theme, else the calendar's. calendar: by date. Or one season always. */
	decorSeason: DecorSeason;
	/** Where falling and twinkling pieces show: the sidebar only, or faintly across the whole screen (back in the sidebar while studying). */
	decorSpread: 'sidebar' | 'screen';
	holidays: Record<HolidayId, boolean>;
	/** Clickable boxes rise a little under the pointer. */
	hoverLift: boolean;
	/** The test-day countdown in the sidebar. */
	showTestDay: boolean;
	motion: 'animated' | 'still';
	pauseWhileStudying: boolean;
	/** Days to move Ramadan by, for local moon sighting (−1, 0 or +1). */
	ramadanOffset: -1 | 0 | 1;
	ramadanGreeting: boolean;
	/** Which menu items show, in order (Settings › Menu & Today). */
	nav: LayoutItem<NavId>[];
	/** Which Today sections show, in order. */
	home: LayoutItem<HomeSectionId>[];
}

/** This device only: an optional theme choice of its own, plus reading preferences. */
export interface DeviceAppearance {
	override: boolean;
	choice: ThemeChoice;
	readingFont: 'serif' | 'sans' | 'legible';
	lineSpacing: 'normal' | 'relaxed';
	reduceMotion: boolean;
	/** The sidebar, open with labels or folded to icons (per device; the boot script applies it before the first paint). */
	sidebar: 'expanded' | 'collapsed';
}

export const DEFAULT_THEME_CHOICE: ThemeChoice = {
	mode: 'pick',
	theme: 'clinic-dark',
	lightTheme: 'clinic-light',
	darkTheme: 'clinic-dark',
	darkFrom: '20:00',
	darkTo: '07:00',
	seasonShade: 'system'
};

export const DEFAULT_APPEARANCE: AccountAppearance = {
	...DEFAULT_THEME_CHOICE,
	page: 'match',
	sectionColors: true,
	focusMode: false,
	textSize: 'default',
	decorations: 'all',
	decorSeason: 'match',
	decorSpread: 'screen',
	holidays: { christmas: true, thanksgiving: true, ramadan: true },
	hoverLift: false,
	showTestDay: true,
	motion: 'animated',
	pauseWhileStudying: true,
	ramadanOffset: 0,
	ramadanGreeting: true,
	nav: DEFAULT_NAV.map((n) => ({ ...n })),
	home: DEFAULT_HOME.map((h) => ({ ...h }))
};

export const DEFAULT_DEVICE: DeviceAppearance = {
	override: false,
	choice: { ...DEFAULT_THEME_CHOICE },
	readingFont: 'serif',
	lineSpacing: 'normal',
	reduceMotion: false,
	sidebar: 'expanded'
};

const THEME_IDS = THEMES.map((t) => t.id) as readonly string[];
const isTheme = (v: unknown): v is ThemeId => typeof v === 'string' && THEME_IDS.includes(v);
const isTime = (v: unknown): v is string => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(v as T) ? (v as T) : fallback);

function cleanChoice(v: Partial<ThemeChoice> | undefined, base: ThemeChoice): ThemeChoice {
	return {
		mode: pick(v?.mode, ['pick', 'system', 'time', 'season'] as const, base.mode),
		theme: isTheme(v?.theme) ? v.theme : base.theme,
		lightTheme: isTheme(v?.lightTheme) ? v.lightTheme : base.lightTheme,
		darkTheme: isTheme(v?.darkTheme) ? v.darkTheme : base.darkTheme,
		darkFrom: isTime(v?.darkFrom) ? v.darkFrom : base.darkFrom,
		darkTo: isTime(v?.darkTo) ? v.darkTo : base.darkTo,
		seasonShade: pick(v?.seasonShade, ['light', 'dark', 'system', 'time'] as const, base.seasonShade ?? 'system')
	};
}

/** Settings from storage or a request, with anything missing or invalid set to its default. */
export function cleanAppearance(v: unknown, base: AccountAppearance = DEFAULT_APPEARANCE): AccountAppearance {
	const a = (v && typeof v === 'object' ? v : {}) as Partial<AccountAppearance>;
	const holidays = (a.holidays && typeof a.holidays === 'object' ? a.holidays : {}) as Partial<Record<HolidayId, unknown>>;
	return {
		...cleanChoice(a, base),
		page: pick(a.page, ['match', 'original', 'dimmed', 'sepia', 'inverted'] as const, base.page),
		sectionColors: typeof a.sectionColors === 'boolean' ? a.sectionColors : base.sectionColors,
		focusMode: typeof a.focusMode === 'boolean' ? a.focusMode : base.focusMode,
		textSize: pick(a.textSize, ['small', 'default', 'large', 'larger'] as const, base.textSize),
		decorations: pick(a.decorations, ['off', 'seasons', 'all'] as const, base.decorations),
		decorSeason: pick(a.decorSeason, ['match', 'calendar', 'spring', 'summer', 'fall', 'winter'] as const, base.decorSeason ?? 'match'),
		decorSpread: pick(a.decorSpread, ['sidebar', 'screen'] as const, base.decorSpread ?? 'screen'),
		hoverLift: typeof a.hoverLift === 'boolean' ? a.hoverLift : (base.hoverLift ?? true),
		showTestDay: typeof a.showTestDay === 'boolean' ? a.showTestDay : (base.showTestDay ?? true),
		holidays: {
			christmas: typeof holidays.christmas === 'boolean' ? holidays.christmas : base.holidays.christmas,
			thanksgiving: typeof holidays.thanksgiving === 'boolean' ? holidays.thanksgiving : base.holidays.thanksgiving,
			ramadan: typeof holidays.ramadan === 'boolean' ? holidays.ramadan : base.holidays.ramadan
		},
		motion: pick(a.motion, ['animated', 'still'] as const, base.motion),
		pauseWhileStudying: typeof a.pauseWhileStudying === 'boolean' ? a.pauseWhileStudying : base.pauseWhileStudying,
		ramadanOffset: a.ramadanOffset === -1 || a.ramadanOffset === 0 || a.ramadanOffset === 1 ? a.ramadanOffset : base.ramadanOffset,
		ramadanGreeting: typeof a.ramadanGreeting === 'boolean' ? a.ramadanGreeting : base.ramadanGreeting,
		nav: cleanLayout(a.nav ?? base.nav, DEFAULT_NAV),
		home: cleanLayout(a.home ?? base.home, DEFAULT_HOME)
	};
}

export function cleanDevice(v: unknown): DeviceAppearance {
	const d = (v && typeof v === 'object' ? v : {}) as Partial<DeviceAppearance>;
	return {
		override: d.override === true,
		choice: cleanChoice(d.choice, DEFAULT_THEME_CHOICE),
		readingFont: pick(d.readingFont, ['serif', 'sans', 'legible'] as const, 'serif'),
		lineSpacing: pick(d.lineSpacing, ['normal', 'relaxed'] as const, 'normal'),
		reduceMotion: d.reduceMotion === true,
		sidebar: d.sidebar === 'collapsed' ? 'collapsed' : 'expanded'
	};
}

/**
 * The device settings from before themes existed ("cortex-appearance"): its
 * light or dark choice becomes this device's own theme if it differs from the
 * account default, and its reading preferences carry over.
 */
export function deviceFromLegacy(old: unknown): DeviceAppearance {
	const o = (old && typeof old === 'object' ? old : {}) as Record<string, unknown>;
	const device = cleanDevice({ readingFont: o.readingFont, lineSpacing: o.lineSpacing, reduceMotion: o.reduceMotion });
	if (o.theme === 'light') device.choice.theme = 'clinic-light';
	if (o.theme === 'light') device.override = true;
	return device;
}

function minutes(t: string) {
	const [h, m] = t.split(':').map(Number);
	return h * 60 + m;
}

/** Whether the dark theme applies at this time (the window can run past midnight). */
export function isDarkTime(now: Date, darkFrom: string, darkTo: string): boolean {
	const m = now.getHours() * 60 + now.getMinutes();
	const from = minutes(darkFrom);
	const to = minutes(darkTo);
	if (from === to) return false;
	return from < to ? m >= from && m < to : m >= from || m < to;
}

/** The theme that applies now: the device's own choice when it has one, else the account's. */
export function resolveTheme(account: ThemeChoice, device: DeviceAppearance | null, env: { prefersDark: boolean; now: Date }): ThemeId {
	const c = device?.override ? device.choice : account;
	if (c.mode === 'system') return env.prefersDark ? c.darkTheme : c.lightTheme;
	if (c.mode === 'time') return isDarkTime(env.now, c.darkFrom, c.darkTo) ? c.darkTheme : c.lightTheme;
	if (c.mode === 'season') {
		const pair = SEASON_THEMES[seasonOfDate(env.now)];
		const shade = c.seasonShade ?? 'system';
		const night = shade === 'dark' || (shade === 'system' && env.prefersDark) || (shade === 'time' && isDarkTime(env.now, c.darkFrom, c.darkTo));
		return night ? pair.night : pair.day;
	}
	return c.theme;
}

export function resolvePageStyle(page: AccountAppearance['page'], theme: ThemeId): PageStyle {
	return page === 'match' ? PAGE_FOR_THEME[theme] : page;
}

export function textScale(size: TextSize): number {
	return TEXT_SIZES.find((s) => s.id === size)?.scale ?? 1;
}
