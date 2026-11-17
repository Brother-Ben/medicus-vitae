import { PlanError, saveSessionPlan, sessionOptions, type PlanItem } from '#lib/server/planner.js';
import type { SessionFocus } from '#lib/focus.js';
import type { RequestHandler } from './$types';

/** What the plan builder can offer: decks, categories, chapters, mistakes, and the focus timer defaults. */
export const GET: RequestHandler = () => Response.json(sessionOptions());

/** Start a session: { budgetMinutes, items, title?, focus? (null: no timer) }. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { budgetMinutes?: number; items?: PlanItem[]; title?: string; focus?: Partial<SessionFocus> | null };
	try {
		const id = saveSessionPlan(Math.max(5, Math.round(Number(body.budgetMinutes) || 30)), Array.isArray(body.items) ? body.items : [], {
			title: body.title,
			focus: body.focus ?? null
		});
		return Response.json({ id }, { status: 201 });
	} catch (err) {
		if (err instanceof PlanError) return Response.json({ error: err.message }, { status: 400 });
		console.error(err);
		return Response.json({ error: 'Could not start the session.' }, { status: 500 });
	}
};
