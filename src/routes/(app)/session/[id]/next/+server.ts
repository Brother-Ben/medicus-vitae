import { redirect } from '@sveltejs/kit';
import { itemHref } from '#lib/session.js';
import { getSessionPlan, setCurrentItem } from '#lib/server/planner.js';
import type { RequestHandler } from './$types';

/**
 * Goes straight to the session's next item (?after=itemId to move past one):
 * its review, chapter or mistake page, or the session page for your own tasks
 * and when everything is done.
 */
export const GET: RequestHandler = ({ params, url }) => {
	const plan = getSessionPlan(params.id);
	if (!plan) redirect(303, '/');
	const after = url.searchParams.get('after');
	const i = after ? plan.items.findIndex((x) => x.id === after) : -1;
	const next = plan.items.slice(i + 1).find((x) => !x.done) ?? plan.items.find((x) => !x.done) ?? null;
	if (!next || plan.status !== 'active') redirect(303, `/session/${plan.id}`);
	setCurrentItem(plan.id, next.id);
	redirect(303, itemHref(plan.id, next) ?? `/session/${plan.id}`);
};
