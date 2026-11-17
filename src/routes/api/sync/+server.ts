import { restoreSnapshot } from '#lib/server/exportimport.js';
import { role } from '#lib/server/instance.js';
import {
	cancelHandoff,
	checkPeer,
	clearPeerConfig,
	makePrimary,
	PeerError,
	peerState,
	pullLatest,
	remoteStatus,
	resolveConflict,
	setPeerConfig
} from '#lib/server/peer.js';
import { createSnapshot, getSnapshot } from '#lib/server/snapshots.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
	try {
		switch (body.action) {
			case 'configure': {
				setPeerConfig(String(body.url ?? ''), String(body.key ?? ''));
				try {
					const status = await remoteStatus();
					return Response.json({ ok: true, message: `Connected to ${status.hostName} (${status.role}).` });
				} catch (err) {
					return Response.json({ ok: true, message: `Saved, but couldn’t reach it yet: ${(err as Error).message}` });
				}
			}
			case 'remove-peer':
				if (role() !== 'primary') throw new PeerError('Make this device primary before removing the other device.');
				clearPeerConfig();
				return Response.json({ ok: true, message: 'Removed.' });
			case 'check':
				if (role() === 'standby') {
					const r = await pullLatest({ fresh: true });
					return Response.json({ ok: true, message: r.applied ? 'Pulled the newest snapshot.' : 'Already up to date.' });
				}
				await checkPeer();
				return Response.json({ ok: true, message: peerState().lastError ?? 'Checked.' });
			case 'promote': {
				const r = await makePrimary(!!body.force);
				return Response.json(r);
			}
			case 'cancel-handoff':
				cancelHandoff();
				return Response.json({ ok: true, message: 'This device is primary again.' });
			case 'resolve':
				return Response.json(await resolveConflict(body.choice === 'keep-mine' ? 'keep-mine' : 'keep-other'));
			case 'snapshot': {
				const meta = await createSnapshot('manual');
				return Response.json({ ok: true, message: 'Snapshot saved.', id: meta.id });
			}
			case 'restore-snapshot': {
				if (role() !== 'primary') throw new PeerError('Only the primary device can restore a snapshot.');
				const meta = getSnapshot(String(body.id ?? ''));
				if (!meta) throw new PeerError('Snapshot not found.');
				await restoreSnapshot(meta);
				return Response.json({ ok: true, message: 'Restored. The data you had before is kept aside and in a pre-restore snapshot.' });
			}
			default:
				return Response.json({ error: 'Unknown action.' }, { status: 400 });
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!(err instanceof PeerError)) console.error(err);
		return Response.json({ error: message }, { status: 400 });
	}
};
