import { error } from '@sveltejs/kit';
import { getSessionPlan } from '#lib/server/planner.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ params, depends }) => {
	depends('app:session');
	const plan = getSessionPlan(params.id);
	if (!plan) error(404, 'Session not found');
	return { plan };
};
