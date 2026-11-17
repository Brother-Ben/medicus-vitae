// Theme resolution: pick, match device and time of day; the per-device override;
// "Match theme" page styles; cleaning saved settings; and the boot script in
// app.html giving the same answers as the app's own code.

import { describe, expect, it } from 'vitest';
import { BOOT_SCRIPT } from './appearance-boot';
import {
	cleanAppearance,
	DEFAULT_APPEARANCE,
	DEFAULT_DEVICE,
	deviceFromLegacy,
	isDarkTime,
	PAGE_FOR_THEME,
	resolvePageStyle,
	resolveTheme,
	THEMES,
	type AccountAppearance,
	type DeviceAppearance
} from './appearance';

const at = (hhmm: string) => {
	const [h, m] = hhmm.split(':').map(Number);
	return new Date(2026, 9, 28, h, m);
};
const light = { prefersDark: false, now: at('12:00') };
const dark = { prefersDark: true, now: at('12:00') };

describe('theme resolution', () => {
	it('uses Clinic Dark by default', () => {
		expect(resolveTheme(DEFAULT_APPEARANCE, null, light)).toBe('clinic-dark');
	});

	it('pick: the chosen theme, whatever the device or time', () => {
		const a = { ...DEFAULT_APPEARANCE, mode: 'pick' as const, theme: 'paper' as const };
		expect(resolveTheme(a, null, light)).toBe('paper');
		expect(resolveTheme(a, null, { prefersDark: true, now: at('23:00') })).toBe('paper');
	});

	it('match device: the light or dark theme the device asks for', () => {
		const a = { ...DEFAULT_APPEARANCE, mode: 'system' as const, lightTheme: 'clinic-light' as const, darkTheme: 'midnight' as const };
		expect(resolveTheme(a, null, light)).toBe('clinic-light');
		expect(resolveTheme(a, null, dark)).toBe('midnight');
	});

	it('time of day: dark from 8:00 PM to 7:00 AM by default, across midnight', () => {
		const a = { ...DEFAULT_APPEARANCE, mode: 'time' as const };
		expect(isDarkTime(at('19:59'), '20:00', '07:00')).toBe(false);
		expect(isDarkTime(at('20:00'), '20:00', '07:00')).toBe(true);
		expect(isDarkTime(at('02:30'), '20:00', '07:00')).toBe(true);
		expect(isDarkTime(at('06:59'), '20:00', '07:00')).toBe(true);
		expect(isDarkTime(at('07:00'), '20:00', '07:00')).toBe(false);
		expect(resolveTheme(a, null, { prefersDark: false, now: at('21:15') })).toBe('clinic-dark');
		expect(resolveTheme(a, null, { prefersDark: true, now: at('10:00') })).toBe('clinic-light');
		// A window inside one day works too.
		expect(isDarkTime(at('13:00'), '12:00', '14:00')).toBe(true);
		expect(isDarkTime(at('15:00'), '12:00', '14:00')).toBe(false);
	});

	it('a device with its own theme overrides the account', () => {
		const account = { ...DEFAULT_APPEARANCE, mode: 'pick' as const, theme: 'clinic-light' as const };
		const phone: DeviceAppearance = { ...DEFAULT_DEVICE, override: true, choice: { ...DEFAULT_DEVICE.choice, mode: 'pick', theme: 'midnight' } };
		expect(resolveTheme(account, phone, light)).toBe('midnight');
		expect(resolveTheme(account, { ...phone, override: false }, light)).toBe('clinic-light');
	});

	it('follow the seasons: the season’s day or night theme', () => {
		const a = { ...DEFAULT_APPEARANCE, mode: 'season' as const, seasonShade: 'system' as const };
		const july = new Date(2026, 6, 4, 12);
		expect(resolveTheme(a, null, { prefersDark: false, now: july })).toBe('summer');
		expect(resolveTheme(a, null, { prefersDark: true, now: july })).toBe('summer-night');
		expect(resolveTheme({ ...a, seasonShade: 'dark' }, null, { prefersDark: false, now: new Date(2026, 3, 1, 12) })).toBe('spring-night');
		expect(resolveTheme({ ...a, seasonShade: 'light' }, null, { prefersDark: true, now: new Date(2026, 11, 1, 12) })).toBe('winter');
		expect(resolveTheme({ ...a, seasonShade: 'time' }, null, { prefersDark: false, now: new Date(2026, 9, 1, 22) })).toBe('fall-night');
	});

	it('Match theme maps each theme to its page style', () => {
		expect(PAGE_FOR_THEME).toMatchObject({ 'clinic-light': 'original', 'clinic-dark': 'dimmed', paper: 'sepia', midnight: 'inverted', 'high-contrast': 'original' });
		for (const t of THEMES) expect(PAGE_FOR_THEME[t.id]).toBeTruthy();
		expect(resolvePageStyle('match', 'paper')).toBe('sepia');
		expect(resolvePageStyle('inverted', 'clinic-light')).toBe('inverted');
	});
});

describe('saved settings', () => {
	it('keeps valid values and replaces invalid ones with defaults', () => {
		const a = cleanAppearance({ theme: 'neon', mode: 'time', darkFrom: '25:00', darkTo: '06:30', textSize: 'huge', page: 'sepia', holidays: { christmas: false }, ramadanOffset: 2 });
		expect(a.theme).toBe('clinic-dark');
		expect(a.mode).toBe('time');
		expect(a.darkFrom).toBe('20:00');
		expect(a.darkTo).toBe('06:30');
		expect(a.textSize).toBe('default');
		expect(a.page).toBe('sepia');
		expect(a.holidays).toEqual({ christmas: false, thanksgiving: true, ramadan: true });
		expect(a.ramadanOffset).toBe(0);
	});

	it('carries a device’s old light/dark choice over', () => {
		expect(deviceFromLegacy({ theme: 'light', readingFont: 'legible' })).toMatchObject({ override: true, choice: { theme: 'clinic-light' }, readingFont: 'legible' });
		expect(deviceFromLegacy({ theme: 'dark' }).override).toBe(false);
		expect(deviceFromLegacy({ theme: 'system' }).override).toBe(false);
	});
});

/** Runs app.html's boot script against a fake page and returns what it set. */
function boot(account: Partial<AccountAppearance> | null, device: unknown, env: { prefersDark: boolean; now: Date }) {
	const attrs: Record<string, string> = {};
	const styles: Record<string, string> = {};
	const store: Record<string, string> = {};
	if (device) store['medicus-appearance'] = JSON.stringify(device);
	const doc = {
		documentElement: { setAttribute: (k: string, v: string) => (attrs[k] = v), style: { setProperty: (k: string, v: string) => (styles[k] = v) } },
		getElementById: (id: string) => (id === 'mv-appearance' && account ? { textContent: JSON.stringify(account) } : null)
	};
	const localStorage = { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => (store[k] = v) };
	const matchMedia = () => ({ matches: env.prefersDark });
	const RealDate = Date;
	const FakeDate = function () {
		return new RealDate(env.now);
	} as unknown as DateConstructor;
	new Function('document', 'localStorage', 'matchMedia', 'window', 'Date', BOOT_SCRIPT)(doc, localStorage, matchMedia, { matchMedia }, FakeDate);
	return { attrs, styles, store };
}

describe('boot script (before the first paint)', () => {
	it('agrees with the app’s own resolution in every mode', () => {
		const accounts: Partial<AccountAppearance>[] = [
			DEFAULT_APPEARANCE,
			{ ...DEFAULT_APPEARANCE, mode: 'pick', theme: 'high-contrast', page: 'match' },
			{ ...DEFAULT_APPEARANCE, mode: 'system', lightTheme: 'paper', darkTheme: 'midnight' },
			{ ...DEFAULT_APPEARANCE, mode: 'time', lightTheme: 'clinic-light', darkTheme: 'clinic-dark', darkFrom: '21:00', darkTo: '06:00', page: 'sepia' },
			{ ...DEFAULT_APPEARANCE, mode: 'season', seasonShade: 'system' },
			{ ...DEFAULT_APPEARANCE, mode: 'season', seasonShade: 'time', darkFrom: '21:00', darkTo: '06:00' },
			{ ...DEFAULT_APPEARANCE, mode: 'season', seasonShade: 'dark', page: 'match' },
			{ ...DEFAULT_APPEARANCE, mode: 'pick', theme: 'summer-night' }
		];
		const devices: (DeviceAppearance | null)[] = [null, { ...DEFAULT_DEVICE, override: true, choice: { ...DEFAULT_DEVICE.choice, mode: 'pick', theme: 'paper' } }];
		const envs = [
			light,
			dark,
			{ prefersDark: false, now: at('22:30') },
			{ prefersDark: true, now: at('05:59') },
			{ prefersDark: false, now: at('06:00') },
			{ prefersDark: false, now: new Date(2026, 3, 10, 12) },
			{ prefersDark: true, now: new Date(2026, 6, 10, 23) },
			{ prefersDark: false, now: new Date(2027, 0, 10, 2) }
		];
		for (const a of accounts) {
			for (const d of devices) {
				for (const env of envs) {
					const full = cleanAppearance(a);
					const expected = resolveTheme(full, d, env);
					const { attrs } = boot(a, d, env);
					expect(attrs['data-theme']).toBe(expected);
					expect(attrs['data-page-style']).toBe(resolvePageStyle(full.page, expected));
				}
			}
		}
	});

	it('applies text size and section colors, and remembers the account settings for offline use', () => {
		const { attrs, styles, store } = boot({ ...DEFAULT_APPEARANCE, textSize: 'larger', sectionColors: false }, null, light);
		expect(styles['--text-scale']).toBe('1.25');
		expect(attrs['data-section-colors']).toBe('off');
		expect(JSON.parse(store['medicus-account-appearance']).textSize).toBe('larger');
	});

	it('works with nothing saved at all (Clinic Dark)', () => {
		expect(boot(null, null, light).attrs['data-theme']).toBe('clinic-dark');
	});

	it('knows every theme in the theme file', () => {
		for (const t of THEMES) expect(BOOT_SCRIPT).toContain(`'${t.id}'`);
	});
});
