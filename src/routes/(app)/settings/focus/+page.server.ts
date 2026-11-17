import { focusPrefs } from '#lib/server/settings.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ prefs: focusPrefs() });
