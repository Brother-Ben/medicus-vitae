import { config } from '#lib/server/config.js';
import { getInstance, hostId, hostName, role } from '#lib/server/instance.js';
import { peerConfig, peerState } from '#lib/server/peer.js';
import { listSnapshots } from '#lib/server/snapshots.js';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = ({ url, depends }) => {
	depends('app:sync');
	const inst = getInstance();
	const peer = peerConfig();
	return {
		device: {
			hostName: hostName(),
			hostId: hostId(),
			role: role(),
			generation: inst?.generation ?? 0,
			installationId: inst?.installationId ?? '',
			isPrimaryHost: inst?.primaryHostId === hostId(),
			promotedAt: inst?.promotedAt ?? null
		},
		pairingKey: inst?.peerKey ?? '',
		thisAddress: url.origin,
		port: config.port,
		dataDir: config.dataDir,
		peer: peer ? { url: peer.url } : null,
		state: peerState(),
		snapshots: listSnapshots().map((s) => ({
			id: s.id,
			type: s.type,
			createdAt: s.createdAt,
			size: s.dbSize,
			files: s.files.length,
			source: s.sourceHostName,
			mine: s.sourceHostId === hostId()
		})),
		snapshotDir: config.paths.snapshots
	};
};
