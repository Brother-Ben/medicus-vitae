// Appearance in the browser: the account's settings (sent with the page, saved
// to the server), this device's own settings (localStorage), and what they
// resolve to right now. Changes apply instantly. app.html's boot script applies
// the same settings before the first paint.

import { ACCOUNT_KEY, DEVICE_KEY, LEGACY_DEVICE_KEY } from '#lib/appearance-boot.js';
import {
	cleanAppearance,
	cleanDevice,
	DEFAULT_APPEARANCE,
	DEFAULT_DEVICE,
	deviceFromLegacy,
	resolvePageStyle,
	resolveTheme,
	textScale,
	type AccountAppearance,
	type DeviceAppearance,
	type PageStyle,
	type ThemeId
} from '#lib/appearance.js';

export const appearance = $state({
	account: { ...DEFAULT_APPEARANCE } as AccountAppearance,
	device: { ...DEFAULT_DEVICE } as DeviceAppearance,
	/** The theme showing now. */
	theme: 'clinic-dark' as ThemeId,
	/** The book page style showing now ("Match theme" resolved). */
	pageStyle: 'dimmed' as PageStyle,
	prefersDark: false,
	/** Set by pages where the owner is studying (review, reader, practice): decorations hold still. */
	studying: false,
	/** Set by the review page while focus mode hides everything but the card. */
	focus: false,
	/** A decoration shown from Settings › Appearance › Preview, whatever the date. */
	preview: null as string | null,
	/** True once the saved settings are read in the browser (until then, pages use what the server sent). */
	loaded: false
});

function readJson(key: string): unknown {
	try {
		return JSON.parse(localStorage.getItem(key) ?? 'null');
	} catch {
		return null;
	}
}

function writeJson(key: string, value: unknown) {
	try {
		localStorage.setItem(key, JSON.stringify(value));
	} catch {
		// Storage unavailable: the change lasts for this visit.
	}
}

let started = false;

export function initAppearance() {
	if (started || typeof document === 'undefined') return;
	started = true;
	let account: unknown = null;
	try {
		account = JSON.parse(document.getElementById('mv-appearance')?.textContent ?? 'null');
	} catch {
		account = null;
	}
	appearance.account = cleanAppearance(account ?? readJson(ACCOUNT_KEY));
	const device = readJson(DEVICE_KEY);
	if (device) appearance.device = cleanDevice(device);
	else {
		const legacy = readJson(LEGACY_DEVICE_KEY);
		appearance.device = legacy ? deviceFromLegacy(legacy) : { ...DEFAULT_DEVICE };
		writeJson(DEVICE_KEY, appearance.device);
	}
	const mq = matchMedia('(prefers-color-scheme: dark)');
	appearance.prefersDark = mq.matches;
	mq.addEventListener('change', (e) => {
		appearance.prefersDark = e.matches;
		apply();
	});
	// "By time of day" switches on the minute; also catch up after the device sleeps.
	setInterval(apply, 30_000);
	document.addEventListener('visibilitychange', () => {
		if (!document.hidden) apply();
	});
	apply();
	appearance.loaded = true;
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let pending: Partial<AccountAppearance> = {};

/** Changes account settings: applied now, saved to the server a moment later. */
export function setAccountAppearance(patch: Partial<AccountAppearance>) {
	appearance.account = cleanAppearance({ ...appearance.account, ...patch, holidays: { ...appearance.account.holidays, ...(patch.holidays ?? {}) } }, appearance.account);
	writeJson(ACCOUNT_KEY, appearance.account);
	apply();
	pending = { ...pending, ...patch, ...(patch.holidays ? { holidays: { ...(pending.holidays ?? {}), ...patch.holidays } } : {}) } as Partial<AccountAppearance>;
	if (saveTimer) clearTimeout(saveTimer);
	saveTimer = setTimeout(() => void flush(), 300);
}

/** Whether the last save reached the server (a standby copy, for one, can't save). */
export const saveStatus = $state({ error: null as string | null });

async function flush() {
	const body = pending;
	pending = {};
	try {
		const res = await fetch('/api/appearance', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
		const data = (await res.json().catch(() => null)) as { appearance?: unknown; error?: string } | null;
		if (!res.ok) throw new Error(data?.error ?? 'Couldn’t save the appearance settings.');
		saveStatus.error = null;
	} catch (err) {
		saveStatus.error = err instanceof Error ? err.message : String(err);
	}
}

/** Changes this device's own settings (kept in this browser only). */
export function setDeviceAppearance(patch: Partial<DeviceAppearance>) {
	appearance.device = cleanDevice({ ...appearance.device, ...patch, choice: { ...appearance.device.choice, ...(patch.choice ?? {}) } });
	writeJson(DEVICE_KEY, appearance.device);
	apply();
}

/** The theme choice in effect: this device's own when it has one, else the account's. */
export function themeChoice() {
	return appearance.device.override ? appearance.device.choice : appearance.account;
}

export function apply() {
	if (typeof document === 'undefined') return;
	const theme = resolveTheme(appearance.account, appearance.device, { prefersDark: appearance.prefersDark, now: new Date() });
	appearance.theme = theme;
	appearance.pageStyle = resolvePageStyle(appearance.account.page, theme);
	const d = document.documentElement;
	d.setAttribute('data-theme', theme);
	d.setAttribute('data-page-style', appearance.pageStyle);
	d.setAttribute('data-section-colors', appearance.account.sectionColors ? 'on' : 'off');
	d.style.setProperty('--text-scale', String(textScale(appearance.account.textSize)));
	d.setAttribute('data-reading-font', appearance.device.readingFont);
	d.setAttribute('data-line-spacing', appearance.device.lineSpacing);
	if (appearance.device.reduceMotion) d.setAttribute('data-reduce-motion', 'true');
	else d.removeAttribute('data-reduce-motion');
	if (appearance.device.sidebar === 'collapsed') d.setAttribute('data-sidebar', 'collapsed');
	else d.removeAttribute('data-sidebar');
	// Phone browsers color their bars to match the app.
	const meta = document.getElementById('mv-theme-color');
	if (meta) meta.setAttribute('content', getComputedStyle(d).getPropertyValue('--sidebar').trim());
}
