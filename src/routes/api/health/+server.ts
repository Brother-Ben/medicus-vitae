import { config } from '#lib/server/config.js';
import { role } from '#lib/server/instance.js';
import type { RequestHandler } from './$types';

/** Used by the tray app and Docker health checks. Reveals nothing about the owner's data. */
export const GET: RequestHandler = () =>
	Response.json({ ok: true, app: 'medicus-vitae', version: config.version, role: role() }, { headers: { 'cache-control': 'no-store' } });
