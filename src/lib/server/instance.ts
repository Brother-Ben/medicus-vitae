import { eq } from 'drizzle-orm';
import { db, kvGet, kvSet } from './db';
import { instance } from './db/schema';
import { token, uuidv7 } from './ids';

/** primary takes changes; standby holds a read-only copy; handing_off is a primary passing the role on. */
export type Role = 'primary' | 'standby' | 'handing_off';

/** Identifies this machine. Stored in the host-local database, so it never travels in a snapshot. */
export function hostId(): string {
	let id = kvGet<string | null>('host_id', null);
	if (!id) {
		id = uuidv7();
		kvSet('host_id', id);
	}
	return id;
}

export function hostName(): string {
	return kvGet<string>('host_name', '') || process.env.COMPUTERNAME || process.env.HOSTNAME || 'this device';
}

export function role(): Role {
	return kvGet<Role>('role', 'primary');
}

export function setRole(r: Role) {
	kvSet('role', r);
}

export function isPrimary() {
	return role() === 'primary';
}

export function getInstance() {
	return db().select().from(instance).where(eq(instance.id, 1)).get();
}

/** First start of a fresh installation: this device becomes primary, generation 1. */
export function ensureInstance() {
	const existing = getInstance();
	if (existing) return existing;
	const now = Date.now();
	db()
		.insert(instance)
		.values({
			id: 1,
			installationId: uuidv7(),
			generation: 1,
			primaryHostId: hostId(),
			promotedAt: now,
			promotedFrom: null,
			peerKey: token(24),
			writeSeq: 0,
			createdAt: now
		})
		.run();
	setRole('primary');
	return getInstance()!;
}

export function writeSeq(): number {
	return getInstance()?.writeSeq ?? 0;
}
