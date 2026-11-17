import { aiConnected } from '#lib/server/ai/providers.js';
import { extensionDir } from '#lib/server/browser-extension.js';
import { carsPrefs, carsStats, carsToday, listPassages } from '#lib/server/cars.js';
import { studyClock } from '#lib/server/settings.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends }) => {
	depends('app:cars');
	const clock = studyClock();
	return {
		today: carsToday(clock),
		stats: carsStats(clock),
		passages: listPassages(),
		prefs: carsPrefs(),
		ai: aiConnected(),
		// The folder for brave://extensions › Load unpacked (one that doesn't move with the app).
		extensionDir: extensionDir()
	};
};
