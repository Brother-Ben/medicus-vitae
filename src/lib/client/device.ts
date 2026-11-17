// Identifies this browser for review events (device id + a per-device sequence
// number, so later sync can preserve each device's review order). Stored in
// localStorage; if storage is unavailable a fresh id is used for this tab.

let memoryId: string | null = null;
let memorySeq = 0;

function read(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null;
	}
}

function write(key: string, value: string) {
	try {
		localStorage.setItem(key, value);
	} catch {
		// private mode: keep it in memory
	}
}

export function deviceId(): string {
	const stored = read('cortex-device-id');
	if (stored) return stored;
	const id = memoryId ?? crypto.randomUUID();
	memoryId = id;
	write('cortex-device-id', id);
	return id;
}

export function nextDeviceSeq(): number {
	const current = Number(read('cortex-device-seq') ?? memorySeq) || 0;
	const next = current + 1;
	memorySeq = next;
	write('cortex-device-seq', String(next));
	return next;
}
