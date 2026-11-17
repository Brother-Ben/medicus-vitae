import { ankiConnectConfig } from '#lib/server/anki/connect.js';
import { syncDecks, syncState } from '#lib/server/anki/sync.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = () => ({ config: ankiConnectConfig(), decks: syncDecks(), state: syncState() });
