import { ankiConnectConfig, ankiStatus, setAnkiConnectConfig, type AnkiConnectConfig } from '#lib/server/anki/connect.js';
import { runSync, setSyncDecks, syncDecks, syncState, SyncError } from '#lib/server/anki/sync.js';
import type { RequestHandler } from './$types';

/** Settings, synced decks, and how the last (or current) sync went. */
export const GET: RequestHandler = () => Response.json({ config: ankiConnectConfig(), decks: syncDecks(), state: syncState() });

/**
 * { action: 'check' } asks Anki whether it's there (and for its decks);
 * { action: 'config', config } saves settings; { action: 'decks', decks: [...] } picks decks;
 * { action: 'sync' } starts a sync in the background (poll GET for progress).
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { action?: string; config?: Partial<AnkiConnectConfig>; decks?: string[] };
	switch (body.action) {
		case 'check':
			return Response.json({ status: await ankiStatus() });
		case 'config':
			return Response.json({ config: setAnkiConnectConfig(body.config ?? {}) });
		case 'decks':
			setSyncDecks(Array.isArray(body.decks) ? body.decks.map(String) : []);
			return Response.json({ decks: syncDecks() });
		case 'sync':
			if (syncState().running) return Response.json({ error: 'A sync is already running.' }, { status: 409 });
			void runSync().catch((err) => {
				if (!(err instanceof SyncError)) console.error(err);
			});
			return Response.json({ started: true, state: syncState() }, { status: 202 });
		default:
			return Response.json({ error: 'Unknown action.' }, { status: 400 });
	}
};
