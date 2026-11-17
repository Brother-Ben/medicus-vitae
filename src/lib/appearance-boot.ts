// The script app.html runs before the first paint (hooks.server.ts inserts it),
// so the page never flashes the wrong theme. It reads the account's settings
// (sent with the page, and remembered for offline use) and this device's own
// settings from localStorage, and resolves them exactly like resolveTheme() and
// resolvePageStyle() in appearance.ts (appearance.spec.ts checks they agree).
// Plain ES5 on purpose: it runs as is, before any app code.

export const ACCOUNT_KEY = 'medicus-account-appearance';
export const DEVICE_KEY = 'medicus-appearance';
export const LEGACY_DEVICE_KEY = 'cortex-appearance';

export const BOOT_SCRIPT = `(function () {
	var d = document.documentElement;
	var THEMES = ['clinic-light', 'clinic-dark', 'paper', 'midnight', 'high-contrast', 'spring', 'spring-night', 'summer', 'summer-night', 'fall', 'fall-night', 'winter', 'winter-night'];
	var PAGE = { 'clinic-light': 'original', 'clinic-dark': 'dimmed', paper: 'sepia', midnight: 'inverted', 'high-contrast': 'original',
		spring: 'original', 'spring-night': 'dimmed', summer: 'original', 'summer-night': 'inverted', fall: 'sepia', 'fall-night': 'dimmed', winter: 'original', 'winter-night': 'inverted' };
	var SCALE = { small: 0.9, 'default': 1, large: 1.12, larger: 1.25 };
	var account = null, device = null;
	try { var el = document.getElementById('mv-appearance'); if (el) account = JSON.parse(el.textContent); } catch (e) {}
	try {
		if (account) localStorage.setItem('${ACCOUNT_KEY}', JSON.stringify(account));
		else account = JSON.parse(localStorage.getItem('${ACCOUNT_KEY}') || 'null');
	} catch (e) {}
	account = account || {};
	try { device = JSON.parse(localStorage.getItem('${DEVICE_KEY}') || 'null'); } catch (e) {}
	if (!device) {
		try {
			var old = JSON.parse(localStorage.getItem('${LEGACY_DEVICE_KEY}') || 'null');
			if (old) device = { override: old.theme === 'light', choice: { mode: 'pick', theme: 'clinic-light' }, readingFont: old.readingFont, lineSpacing: old.lineSpacing, reduceMotion: old.reduceMotion };
		} catch (e) {}
	}
	device = device || {};
	function theme(v, f) { return THEMES.indexOf(v) >= 0 ? v : f; }
	function mins(t, f) { var m = /^([01]\\d|2[0-3]):([0-5]\\d)$/.exec(t || ''); return m ? +m[1] * 60 + +m[2] : f; }
	var c = device.override === true && device.choice ? device.choice : account;
	var mode = c.mode === 'system' || c.mode === 'time' || c.mode === 'season' ? c.mode : 'pick';
	var light = theme(c.lightTheme, 'clinic-light'), dark = theme(c.darkTheme, 'clinic-dark');
	var t = theme(c.theme, 'clinic-dark');
	var prefersDark = !!(window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches);
	var now = new Date(), m = now.getHours() * 60 + now.getMinutes(), from = mins(c.darkFrom, 1200), to = mins(c.darkTo, 420);
	var darkTime = from === to ? false : from < to ? m >= from && m < to : m >= from || m < to;
	if (mode === 'system') t = prefersDark ? dark : light;
	if (mode === 'time') t = darkTime ? dark : light;
	if (mode === 'season') {
		var mo = now.getMonth();
		var season = mo >= 8 && mo <= 10 ? 'fall' : mo === 11 || mo <= 1 ? 'winter' : mo <= 4 ? 'spring' : 'summer';
		var shade = c.seasonShade === 'light' || c.seasonShade === 'dark' || c.seasonShade === 'time' ? c.seasonShade : 'system';
		var night = shade === 'dark' || (shade === 'system' && prefersDark) || (shade === 'time' && darkTime);
		t = night ? season + '-night' : season;
	}
	d.setAttribute('data-theme', t);
	var page = account.page;
	d.setAttribute('data-page-style', page === 'original' || page === 'dimmed' || page === 'sepia' || page === 'inverted' ? page : PAGE[t]);
	d.setAttribute('data-section-colors', account.sectionColors === false ? 'off' : 'on');
	d.style.setProperty('--text-scale', String(SCALE[account.textSize] || 1));
	if (device.readingFont === 'sans' || device.readingFont === 'legible') d.setAttribute('data-reading-font', device.readingFont);
	if (device.lineSpacing === 'relaxed') d.setAttribute('data-line-spacing', 'relaxed');
	if (device.reduceMotion === true) d.setAttribute('data-reduce-motion', 'true');
	if (device.sidebar === 'collapsed') d.setAttribute('data-sidebar', 'collapsed');
})();`;
