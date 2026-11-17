import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from './config';
import { kvGet, kvSet, sqlite, swapMainDatabase } from './db';
import { commitTmpFile, storedFileExists } from './files';
import { clearSchedulerCache } from './fsrs';
import { uuidv7 } from './ids';
import { getInstance, hostId, hostName, role, setRole, type Role } from './instance';
import { resumeJobs, stopJobs } from './jobs';
import {
	changedSince,
	createSnapshot,
	finalizeBackupFile,
	gunzipFile,
	integrityOk,
	latestSnapshot,
	removeDbFile,
	sha256File,
	writeMeta,
	type SnapshotMeta
} from './snapshots';

// Windows fallback (SYNC-02, spec Section 11). One device is primary (takes
// changes); the other is a standby that pulls the primary's newest snapshot and
// shows it read-only. Switching is manual: "Make this device primary". A device
// that comes back and finds a newer primary steps down, keeps its own database
// aside, and if both devices took changes, both copies are kept and the owner
// chooses (generation numbers tell which device is newer).

export interface PeerConfig {
	url: string;
	key: string;
}

export interface HeldSnapshot {
	snapshotId: string;
	createdAt: number;
	sourceHostId: string;
	sourceHostName: string;
	generation: number;
	writeSeq: number;
	appliedAt: number;
}

export interface Conflict {
	detectedAt: number;
	keptAsidePath: string;
	localChanges: number;
	otherHostName: string;
	otherGeneration: number;
	localGeneration: number;
	reason: string;
}

export interface PeerState {
	lastContactAt: number | null;
	lastError: string | null;
	lastPullAt: number | null;
	peerHostName: string | null;
	peerRole: Role | null;
	peerGeneration: number | null;
	held: HeldSnapshot | null;
	conflict: Conflict | null;
	keptAside: { path: string; at: number; reason: string } | null;
	handoffStartedAt: number | null;
}

const EMPTY_STATE: PeerState = {
	lastContactAt: null,
	lastError: null,
	lastPullAt: null,
	peerHostName: null,
	peerRole: null,
	peerGeneration: null,
	held: null,
	conflict: null,
	keptAside: null,
	handoffStartedAt: null
};

export class PeerError extends Error {}

export function peerConfig(): PeerConfig | null {
	return kvGet<PeerConfig | null>('peer', null);
}

export function setPeerConfig(url: string, key: string) {
	let u: URL;
	try {
		u = new URL(url.trim());
	} catch {
		throw new PeerError('Enter the other device’s address, like http://my-server:8080 or https://my-server.tailnet.ts.net');
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new PeerError('The address must start with http:// or https://');
	const clean = `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
	if (!key.trim()) throw new PeerError('Enter the pairing key shown on the other device.');
	kvSet('peer', { url: clean, key: key.trim() });
}

export function clearPeerConfig() {
	kvSet('peer', null);
}

export function peerState(): PeerState {
	return { ...EMPTY_STATE, ...kvGet<Partial<PeerState>>('peer_state', {}) };
}

function updateState(patch: Partial<PeerState>) {
	kvSet('peer_state', { ...peerState(), ...patch });
}

// ------------------------------------------------------- incoming auth

export function verifyPeerKey(authorization: string | null): boolean {
	const m = /^Bearer\s+(.+)$/i.exec(authorization ?? '');
	const inst = getInstance();
	if (!m || !inst) return false;
	const a = createHash('sha256').update(m[1]).digest();
	const b = createHash('sha256').update(inst.peerKey).digest();
	return timingSafeEqual(a, b);
}

export interface PeerStatus {
	installationId: string | null;
	hostId: string;
	hostName: string;
	role: Role;
	generation: number;
	primaryHostId: string | null;
	writeSeq: number;
	promotedFrom: { hostId: string; snapshotId: string | null; writeSeq: number; generation: number } | null;
	latestSnapshot: SnapshotMeta | null;
	appVersion: string;
}

export function ownSnapshots() {
	return latestSnapshot(['hourly', 'daily', 'manual', 'pre-upgrade', 'handoff', 'pre-promotion']);
}

export function localStatus(): PeerStatus {
	const inst = getInstance();
	const latest = ownSnapshots();
	return {
		installationId: inst?.installationId ?? null,
		hostId: hostId(),
		hostName: hostName(),
		role: role(),
		generation: inst?.generation ?? 0,
		primaryHostId: inst?.primaryHostId ?? null,
		writeSeq: inst?.writeSeq ?? 0,
		promotedFrom: inst?.promotedFrom ?? null,
		latestSnapshot: latest && latest.sourceHostId === hostId() ? latest : null,
		appVersion: config.version
	};
}

/** For a standby pulling from this device: the newest snapshot, made fresh when needed. */
export async function snapshotForPeer(fresh: boolean): Promise<SnapshotMeta | null> {
	const latest = ownSnapshots();
	const mine = latest && latest.sourceHostId === hostId() ? latest : null;
	const stale = !mine || Date.now() - mine.createdAt > 50 * 60_000;
	if (role() === 'primary' && (fresh || stale) && changedSince(['hourly', 'daily', 'manual', 'pre-upgrade', 'handoff', 'pre-promotion'])) {
		return createSnapshot('hourly');
	}
	return mine;
}

// ------------------------------------------------------- outgoing calls

async function call(cfg: PeerConfig, pathname: string, init: { method?: string; body?: unknown; timeoutMs?: number } = {}) {
	let res: Response;
	try {
		res = await fetch(cfg.url + pathname, {
			method: init.method ?? 'GET',
			headers: { authorization: `Bearer ${cfg.key}`, 'content-type': 'application/json' },
			body: init.body === undefined ? undefined : JSON.stringify(init.body),
			signal: AbortSignal.timeout(init.timeoutMs ?? 15_000)
		});
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		throw new PeerError(`Couldn’t reach ${cfg.url} (${reason}).`);
	}
	if (res.status === 401) throw new PeerError('The other device rejected the pairing key.');
	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new PeerError(`The other device answered ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`);
	}
	return res;
}

export async function remoteStatus(cfg = peerConfig()): Promise<PeerStatus> {
	if (!cfg) throw new PeerError('No other device is set up.');
	const status = (await (await call(cfg, '/api/peer/status')).json()) as PeerStatus;
	updateState({
		lastContactAt: Date.now(),
		lastError: null,
		peerHostName: status.hostName,
		peerRole: status.role,
		peerGeneration: status.generation
	});
	return status;
}

async function download(cfg: PeerConfig, pathname: string, dest: string) {
	const res = await call(cfg, pathname, { timeoutMs: 30 * 60_000 });
	if (!res.body) throw new PeerError('Empty download.');
	await pipeline(Readable.fromWeb(res.body as import('node:stream/web').ReadableStream), fs.createWriteStream(dest));
}

/** Downloads a snapshot and the book files it needs, verifying every hash. Returns the gz path. */
async function fetchSnapshot(cfg: PeerConfig, meta: SnapshotMeta) {
	fs.mkdirSync(config.paths.peer, { recursive: true });
	const gz = path.join(config.paths.peer, `${meta.id}.sqlite.gz`);
	if (!fs.existsSync(gz) || (await sha256File(gz)) !== meta.dbSha256) {
		const part = gz + '.part';
		await download(cfg, `/api/peer/snapshot/${encodeURIComponent(meta.id)}`, part);
		if ((await sha256File(part)) !== meta.dbSha256) {
			fs.rmSync(part, { force: true });
			throw new PeerError('The snapshot was damaged in transit. It will be tried again.');
		}
		fs.renameSync(part, gz);
	}
	for (const f of meta.files) {
		if (storedFileExists(f.hash, f.ext)) continue;
		const part = path.join(config.paths.tmp, `peer-${uuidv7()}.part`);
		await download(cfg, `/api/peer/file/${f.hash}.${f.ext}`, part);
		if ((await sha256File(part)) !== f.hash) {
			fs.rmSync(part, { force: true });
			throw new PeerError('A book file was damaged in transit. It will be tried again.');
		}
		commitTmpFile(part, f.hash, f.ext);
	}
	return gz;
}

/** Replaces the live database with a downloaded snapshot (standby only). */
async function applySnapshot(meta: SnapshotMeta, gz: string) {
	const tmp = path.join(config.paths.tmp, `apply-${uuidv7()}.sqlite`);
	await gunzipFile(gz, tmp);
	if (!integrityOk(tmp)) {
		removeDbFile(tmp);
		throw new PeerError('The downloaded snapshot failed its integrity check.');
	}
	const previous = path.join(config.paths.peer, 'previous.sqlite');
	removeDbFile(previous);
	await swapMainDatabase(tmp, previous);
	removeDbFile(tmp);
	clearSchedulerCache();
	// Keep the copy as this device's newest held snapshot.
	const keptName = `${meta.id}.sqlite.gz`;
	const keptPath = path.join(config.paths.snapshots, keptName);
	if (!fs.existsSync(keptPath)) fs.copyFileSync(gz, keptPath);
	writeMeta({ ...meta, type: 'peer', dbFile: keptName });
	fs.rmSync(gz, { force: true });
	updateState({
		held: {
			snapshotId: meta.id,
			createdAt: meta.createdAt,
			sourceHostId: meta.sourceHostId,
			sourceHostName: meta.sourceHostName,
			generation: meta.generation,
			writeSeq: meta.writeSeq,
			appliedAt: Date.now()
		},
		lastPullAt: Date.now()
	});
}

let pulling: Promise<unknown> | null = null;

/** Standby: fetch and apply the primary's newest snapshot if it's newer than the one held. */
export function pullLatest(opts: { fresh?: boolean; allowOtherInstallation?: boolean } = {}) {
	if (pulling) return pulling as Promise<{ applied: boolean; meta: SnapshotMeta | null }>;
	const run = async () => {
		const cfg = peerConfig();
		if (!cfg) throw new PeerError('No other device is set up.');
		if (role() !== 'standby') throw new PeerError('Only a standby pulls snapshots.');
		const status = await remoteStatus(cfg);
		const mine = getInstance();
		if (!opts.allowOtherInstallation && mine && status.installationId && mine.installationId !== status.installationId) {
			const hasData = !!sqlite().prepare('SELECT 1 FROM user WHERE id = 1').get();
			if (hasData) throw new PeerError('That device belongs to a different installation.');
		}
		if (status.role !== 'primary') return { applied: false, meta: null };
		const res = await call(cfg, `/api/peer/snapshot/latest${opts.fresh ? '?fresh=1' : ''}`, { timeoutMs: 120_000 });
		const meta = (await res.json()) as SnapshotMeta | null;
		if (!meta) return { applied: false, meta: null };
		if (peerState().held?.snapshotId === meta.id) return { applied: false, meta };
		const gz = await fetchSnapshot(cfg, meta);
		await applySnapshot(meta, gz);
		return { applied: true, meta };
	};
	pulling = run()
		.catch((err) => {
			updateState({ lastError: err instanceof Error ? err.message : String(err) });
			throw err;
		})
		.finally(() => {
			pulling = null;
		});
	return pulling as Promise<{ applied: boolean; meta: SnapshotMeta | null }>;
}

/** Makes a consistent copy of the live database in data/kept-aside. */
async function keepAside(reason: string) {
	fs.mkdirSync(config.paths.keptAside, { recursive: true });
	const inst = getInstance();
	const file = path.join(
		config.paths.keptAside,
		`cortex-${new Date().toISOString().replace(/[:.]/g, '-')}-gen${inst?.generation ?? 0}.sqlite`
	);
	await sqlite().backup(file);
	finalizeBackupFile(file);
	updateState({ keptAside: { path: file, at: Date.now(), reason } });
	return file;
}

/** A newer primary exists: switch to standby, keeping this device's database aside first. */
async function stepDown(remote: PeerStatus) {
	const inst = getInstance();
	const localSeq = inst?.writeSeq ?? 0;
	const base = remote.promotedFrom;
	const diverged = !base || base.hostId !== hostId() ? localSeq > 0 : localSeq > base.writeSeq;
	const kept = await keepAside(`Switched to standby because ${remote.hostName} became primary`);
	await stopJobs();
	setRole('standby');
	if (diverged && role() === 'standby') {
		updateState({
			conflict: {
				detectedAt: Date.now(),
				keptAsidePath: kept,
				localChanges: base && base.hostId === hostId() ? localSeq - base.writeSeq : localSeq,
				otherHostName: remote.hostName,
				otherGeneration: remote.generation,
				localGeneration: inst?.generation ?? 0,
				reason:
					'This device has changes the other device never received: it took changes after the copy the other device started from. Both copies are kept.'
			}
		});
	}
	await pullLatest({ fresh: true });
}

let checking = false;

/** Periodic check (every few minutes, and at startup) when another device is set up. */
export async function checkPeer() {
	const cfg = peerConfig();
	if (!cfg || checking) return;
	checking = true;
	try {
		const me = localStatus();
		if (me.role === 'standby') {
			await pullLatest();
			return;
		}
		let remote: PeerStatus;
		try {
			remote = await remoteStatus(cfg);
		} catch (err) {
			updateState({ lastError: err instanceof Error ? err.message : String(err) });
			if (me.role === 'handing_off') maybeCancelStaleHandoff();
			return;
		}
		if (remote.installationId && me.installationId && remote.installationId !== me.installationId) {
			updateState({ lastError: 'The other device belongs to a different installation.' });
			return;
		}
		if (remote.role === 'primary' && remote.generation > me.generation) {
			await stepDown(remote);
		} else if (me.role === 'primary' && remote.role === 'primary' && remote.generation === me.generation && remote.hostId !== me.hostId) {
			updateState({ lastError: 'Both devices say they are primary at the same generation. Stop one and make the other primary.' });
		} else if (me.role === 'handing_off') {
			maybeCancelStaleHandoff();
		}
	} catch (err) {
		updateState({ lastError: err instanceof Error ? err.message : String(err) });
	} finally {
		checking = false;
	}
}

function maybeCancelStaleHandoff() {
	const started = peerState().handoffStartedAt;
	if (started && Date.now() - started > 10 * 60_000) cancelHandoff();
}

// ------------------------------------------------------------ handoff

/** On the current primary, at the other device's request: stop taking changes and make a final snapshot. */
export async function prepareHandoff() {
	if (role() === 'standby') return { snapshot: null as SnapshotMeta | null, status: localStatus() };
	setRole('handing_off');
	updateState({ handoffStartedAt: Date.now() });
	await stopJobs();
	const snapshot = await createSnapshot('handoff');
	return { snapshot, status: localStatus() };
}

/** The other device is primary now. */
export async function completeHandoff(newPrimaryHostId: string, generation: number) {
	const inst = getInstance();
	if (newPrimaryHostId === hostId()) return;
	if (role() === 'primary') {
		// Told to step down without a prepare (the owner kept the other copy): keep this one aside.
		await keepAside('Switched to standby at the other device’s request');
	}
	await stopJobs();
	setRole('standby');
	updateState({ handoffStartedAt: null, peerGeneration: generation });
	if (inst) {
		const latest = ownSnapshots();
		updateState({
			held: {
				snapshotId: latest?.id ?? 'local',
				createdAt: latest?.createdAt ?? Date.now(),
				sourceHostId: hostId(),
				sourceHostName: hostName(),
				generation: inst.generation,
				writeSeq: inst.writeSeq,
				appliedAt: Date.now()
			}
		});
	}
	// Fetch the new primary's state shortly (not inside its request).
	setTimeout(() => void pullLatest({ fresh: true }).catch(() => {}), 1500);
}

export function cancelHandoff() {
	if (role() !== 'handing_off') return;
	setRole('primary');
	updateState({ handoffStartedAt: null });
	resumeJobs();
}

function claim(generation: number, from: { hostId: string; snapshotId: string | null; writeSeq: number; generation: number }) {
	sqlite()
		.prepare('UPDATE instance SET generation = ?, primary_host_id = ?, promoted_at = ?, promoted_from = ? WHERE id = 1')
		.run(generation, hostId(), Date.now(), JSON.stringify(from));
	setRole('primary');
	updateState({ conflict: null });
	resumeJobs();
}

export interface PromotionResult {
	ok: boolean;
	needsConfirm?: boolean;
	message: string;
	heldAgeMs?: number | null;
}

/** "Make this device primary" (spec 11.3). */
export async function makePrimary(force = false): Promise<PromotionResult> {
	if (role() === 'primary') return { ok: true, message: 'This device is already primary.' };
	if (role() === 'handing_off') {
		cancelHandoff();
		return { ok: true, message: 'Handoff cancelled. This device is primary again.' };
	}
	const cfg = peerConfig();
	const held = peerState().held;
	let remote: PeerStatus | null = null;
	if (cfg) {
		try {
			remote = await remoteStatus(cfg);
		} catch {
			remote = null;
		}
	}
	const inst = getInstance();
	if (remote && cfg && remote.role !== 'standby') {
		// Normal switch: the other device stops, makes a final snapshot, and we take it.
		const prep = (await (await call(cfg, '/api/peer/handoff/prepare', { method: 'POST', body: {}, timeoutMs: 180_000 })).json()) as {
			snapshot: SnapshotMeta | null;
		};
		if (prep.snapshot && prep.snapshot.id !== held?.snapshotId) {
			const gz = await fetchSnapshot(cfg, prep.snapshot);
			await applySnapshot(prep.snapshot, gz);
		}
		const current = getInstance();
		const generation = Math.max(remote.generation, current?.generation ?? 0) + 1;
		claim(generation, {
			hostId: remote.hostId,
			snapshotId: prep.snapshot?.id ?? held?.snapshotId ?? null,
			writeSeq: current?.writeSeq ?? 0,
			generation: remote.generation
		});
		try {
			await call(cfg, '/api/peer/handoff/complete', {
				method: 'POST',
				body: { primaryHostId: hostId(), generation }
			});
		} catch {
			// It will notice the newer generation on its next check.
		}
		await createSnapshot('pre-promotion').catch(() => {});
		return { ok: true, message: `This device is now primary. ${remote.hostName} switched to standby.` };
	}

	const heldAgeMs = held ? Date.now() - held.createdAt : null;
	if (!force) {
		return {
			ok: false,
			needsConfirm: true,
			heldAgeMs,
			message: remote
				? `${remote.hostName} is a standby too. Its newest copy may be older than this one.`
				: 'The other device can’t be reached. Make sure it is stopped before continuing, or changes made there won’t be included.'
		};
	}
	const generation = Math.max(inst?.generation ?? 0, remote?.generation ?? 0) + 1;
	claim(generation, {
		hostId: held?.sourceHostId ?? inst?.primaryHostId ?? 'unknown',
		snapshotId: held?.snapshotId ?? null,
		writeSeq: inst?.writeSeq ?? 0,
		generation: inst?.generation ?? 0
	});
	await createSnapshot('pre-promotion').catch(() => {});
	return { ok: true, message: 'This device is now primary.' };
}

/** After a conflict: keep the other device's copy (done) or restore this device's kept-aside copy. */
export async function resolveConflict(choice: 'keep-other' | 'keep-mine') {
	const state = peerState();
	const conflict = state.conflict;
	if (!conflict) return { ok: true, message: 'Nothing to resolve.' };
	if (choice === 'keep-other') {
		updateState({ conflict: null });
		return { ok: true, message: `Keeping ${conflict.otherHostName}’s copy. This device’s copy stays at ${conflict.keptAsidePath}.` };
	}
	if (!fs.existsSync(conflict.keptAsidePath)) throw new PeerError('The kept-aside copy is missing.');
	const cfg = peerConfig();
	let remote: PeerStatus | null = null;
	if (cfg) {
		try {
			remote = await remoteStatus(cfg);
		} catch {
			remote = null;
		}
	}
	if (cfg && remote?.role === 'primary') {
		// Ask the other device to stop and preserve its own copy before we take over.
		await call(cfg, '/api/peer/handoff/prepare', { method: 'POST', body: {}, timeoutMs: 180_000 });
	}
	const tmp = path.join(config.paths.tmp, `conflict-${uuidv7()}.sqlite`);
	fs.copyFileSync(conflict.keptAsidePath, tmp);
	await keepAside('Replaced while keeping this device’s own copy');
	await swapMainDatabase(tmp, null);
	clearSchedulerCache();
	const current = getInstance();
	const generation = Math.max(current?.generation ?? 0, conflict.otherGeneration, remote?.generation ?? 0) + 1;
	claim(generation, {
		hostId: remote?.hostId ?? 'unknown',
		snapshotId: null,
		writeSeq: current?.writeSeq ?? 0,
		generation: remote?.generation ?? conflict.otherGeneration
	});
	if (cfg && remote) {
		try {
			await call(cfg, '/api/peer/handoff/complete', { method: 'POST', body: { primaryHostId: hostId(), generation } });
		} catch {
			// It will notice on its next check.
		}
	}
	return { ok: true, message: 'Kept this device’s copy. This device is primary again.' };
}

/** Standby setup from a fresh installation: connect, pull the primary's copy, become its standby. */
export async function setUpAsStandby(url: string, key: string) {
	setPeerConfig(url, key);
	setRole('standby');
	await stopJobs();
	try {
		const result = await pullLatest({ fresh: true, allowOtherInstallation: true });
		if (!result.applied && !peerState().held) {
			throw new PeerError('The other device has no snapshot to share yet, or is not primary.');
		}
	} catch (err) {
		setRole('primary');
		clearPeerConfig();
		resumeJobs();
		throw err;
	}
}

export function stopBeingStandby() {
	// Used when the owner removes the other device without promoting: only allowed for a primary.
	if (role() !== 'primary') throw new PeerError('Make this device primary first.');
	clearPeerConfig();
}
