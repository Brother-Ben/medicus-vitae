import { localStatus } from '#lib/server/peer.js';
import { peerDenied } from '#lib/server/peer-http.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ request }) => peerDenied(request) ?? Response.json(localStatus());
