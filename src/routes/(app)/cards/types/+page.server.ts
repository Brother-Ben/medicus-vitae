import { aiConnected } from '#lib/server/ai/providers.js';
import { carsToday } from '#lib/server/cars.js';
import { ensureImageOcclusionType, listNoteTypes } from '#lib/server/note-types.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ depends }) => {
	depends('app:note-types');
	ensureImageOcclusionType();
	return { types: listNoteTypes(), ai: aiConnected(), carsWaiting: carsToday().waiting };
};
