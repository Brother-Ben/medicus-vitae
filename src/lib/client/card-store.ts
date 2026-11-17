// What Anki card scripts save with localStorage / sessionStorage. The card frame
// can't use the browser's storage (it is sealed off with an opaque origin), so
// it reports changes here. As in Anki, "local" values last across visits and
// "session" values until the page is closed.

export interface CardStore {
	localStorage: Record<string, string>;
	sessionStorage: Record<string, string>;
}

const KEY = 'medicus-card-storage';
const MAX_BYTES = 200_000;

function load(): Record<string, string> {
	try {
		const v = JSON.parse(localStorage.getItem(KEY) ?? '{}');
		return v && typeof v === 'object' ? v : {};
	} catch {
		return {};
	}
}

export const cardStore: CardStore = { localStorage: typeof localStorage === 'undefined' ? {} : load(), sessionStorage: {} };

let timer: ReturnType<typeof setTimeout> | null = null;

/** Saves the "local" values soon (a card can write many at once). */
export function persistCardStore() {
	if (timer) return;
	timer = setTimeout(() => {
		timer = null;
		try {
			const text = JSON.stringify(cardStore.localStorage);
			if (text.length <= MAX_BYTES) localStorage.setItem(KEY, text);
		} catch {
			// Storage unavailable or full: values last for this visit.
		}
	}, 500);
}
