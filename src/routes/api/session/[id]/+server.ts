import {
	editSession,
	endSession,
	getSessionPlan,
	PlanError,
	setCurrentItem,
	setSessionItemDone,
	timerAction,
	type PlanItem,
	type TimerAction
} from '#lib/server/planner.js';
import type { SessionFocus } from '#lib/focus.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ params }) => {
	const plan = getSessionPlan(params.id);
	if (!plan) return Response.json({ error: 'Session not found.' }, { status: 404 });
	return Response.json({ plan });
};

/**
 * Change a session: { itemId, done } marks an item, { current } picks the item
 * being worked on, { timer: 'pause' | 'resume' | 'start' | 'skip' | 'next-phase' | 'extend', minutes? }
 * moves the focus timer, { add | remove | move | budgetMinutes | title | focus } edits it, { end } ends it.
 */
export const POST: RequestHandler = async ({ params, request }) => {
	if (!getSessionPlan(params.id)) return Response.json({ error: 'Session not found.' }, { status: 404 });
	const body = (await request.json().catch(() => ({}))) as {
		itemId?: string;
		done?: boolean;
		current?: string;
		end?: boolean;
		timer?: TimerAction;
		minutes?: number;
		add?: PlanItem[];
		remove?: string;
		move?: { itemId: string; by: -1 | 1 };
		budgetMinutes?: number;
		title?: string;
		focus?: Partial<SessionFocus> | null;
	};
	try {
		if (body.end) endSession(params.id);
		else if (body.timer) timerAction(params.id, body.timer, Number(body.minutes ?? 5));
		else if (body.current) setCurrentItem(params.id, body.current);
		else if (body.itemId) setSessionItemDone(params.id, body.itemId, !!body.done);
		else if (body.add || body.remove || body.move || body.budgetMinutes !== undefined || body.title !== undefined || body.focus !== undefined) {
			editSession(params.id, {
				add: body.add,
				remove: body.remove,
				move: body.move ? { itemId: String(body.move.itemId), by: body.move.by === -1 ? -1 : 1 } : undefined,
				budgetMinutes: body.budgetMinutes,
				title: body.title,
				focus: body.focus
			});
		}
		return Response.json({ plan: getSessionPlan(params.id) });
	} catch (err) {
		if (err instanceof PlanError) return Response.json({ error: err.message }, { status: 400 });
		console.error(err);
		return Response.json({ error: 'Could not change the session.' }, { status: 500 });
	}
};
