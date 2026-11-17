// Two-device switch-over test (spec 11.3): S = server, W = Windows standby, both
// real Cortex servers on ports 8201/8202 with throwaway data folders.
//   node tests/e2e/switch-over.mjs <projectRoot> <scratchDir>
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const [root, scratch] = process.argv.slice(2);
const require = createRequire(path.join(root, 'package.json'));
const Database = require('better-sqlite3');
const nodeExe = process.execPath;

let failures = 0;
const check = (label, cond, extra = '') => {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
	if (!cond) failures++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeDevice(name, port) {
	const dataDir = path.join(scratch, `sync-${name}`);
	fs.rmSync(dataDir, { recursive: true, force: true });
	const base = `http://127.0.0.1:${port}`;
	const dev = { name, port, base, dataDir, proc: null, cookie: '', log: '' };
	dev.start = async () => {
		dev.proc = spawn(nodeExe, [path.join(root, 'server', 'index.js')], {
			cwd: root,
			// CORTEX_EXTENSION_DIR: the browser extension's copy stays in the scratch folder, not your own.
			env: { ...process.env, PORT: String(port), CORTEX_DATA_DIR: dataDir, CORTEX_EXTENSION_DIR: path.join(dataDir, 'browser-extension'), CORTEX_WATCH_STDIN: '1', CORTEX_ENV_LOADED: '1' },
			stdio: ['pipe', 'pipe', 'pipe']
		});
		dev.proc.stdout.on('data', (d) => (dev.log += d));
		dev.proc.stderr.on('data', (d) => (dev.log += d));
		for (let i = 0; i < 80; i++) {
			try {
				if ((await fetch(base + '/api/health')).ok) return;
			} catch {}
			await sleep(250);
		}
		throw new Error(`${name} did not start:\n${dev.log}`);
	};
	dev.stop = async () => {
		if (!dev.proc) return;
		const p = dev.proc;
		const exited = new Promise((r) => p.on('exit', r));
		p.stdin.end();
		await exited;
		dev.proc = null;
	};
	dev.health = async () => (await fetch(base + '/api/health')).json();
	dev.req = async (method, p, { form, json } = {}) => {
		const headers = { origin: base, accept: 'text/html' };
		if (dev.cookie) headers.cookie = dev.cookie;
		let body;
		if (form) {
			headers['content-type'] = 'application/x-www-form-urlencoded';
			body = new URLSearchParams(form).toString();
		} else if (json !== undefined) {
			headers['content-type'] = 'application/json';
			headers.accept = 'application/json';
			body = JSON.stringify(json);
		}
		const res = await fetch(base + p, { method, headers, body, redirect: 'manual' });
		for (const c of res.headers.getSetCookie()) {
			const [pair] = c.split(';');
			if (pair.startsWith('cortex_session=')) dev.cookie = pair.endsWith('=') ? '' : pair;
		}
		return res;
	};
	dev.json = async (method, p, json) => {
		const res = await dev.req(method, p, { json });
		const data = await res.json().catch(() => ({}));
		if (!res.ok) throw new Error(`${name} ${p}: ${res.status} ${JSON.stringify(data)}`);
		return data;
	};
	dev.login = async () => {
		const r = await dev.req('POST', '/login?/password', { form: { password: 'correct horse battery', next: '/' } });
		if (r.status !== 303) throw new Error(`${name} login failed: ${r.status}`);
	};
	dev.count = (table) => {
		const db = new Database(path.join(dataDir, 'cortex.sqlite'), { readonly: true });
		try {
			return db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
		} finally {
			db.close();
		}
	};
	dev.reviewOne = async () => {
		const { card } = await dev.json('GET', '/api/review');
		if (!card) throw new Error(`${name}: nothing to review`);
		const r = await dev.json('POST', '/api/review', {
			cardId: card.cardId,
			rating: 3,
			eventId: card.eventId,
			timeTakenMs: 5000,
			deviceId: `dev-${name}`,
			deviceSeq: Date.now() % 1e9,
			baseRev: card.rev
		});
		return r.result.status;
	};
	return dev;
}

const S = makeDevice('server', 8201);
const W = makeDevice('windows', 8202);

try {
	// --- S: set up with some study history.
	await S.start();
	let r = await S.req('POST', '/setup?/create', { form: { displayName: 'Sam', password: 'correct horse battery', confirm: 'correct horse battery', timeZone: 'America/Chicago' } });
	check('S account created', r.status === 303);
	for (let i = 0; i < 4; i++) await S.json('POST', '/api/cards', { note: { kind: 'basic', fields: { Front: `Q${i}`, Back: `A${i}` }, aamcCode: '1A' } });
	for (let i = 0; i < 3; i++) await S.reviewOne();
	const key = (() => {
		const db = new Database(path.join(S.dataDir, 'cortex.sqlite'), { readonly: true });
		try {
			return db.prepare('SELECT peer_key FROM instance').get().peer_key;
		} finally {
			db.close();
		}
	})();

	// --- W: fresh install, set up as standby of S.
	await W.start();
	r = await W.req('POST', '/setup?/standby', { form: { peerUrl: S.base, peerKey: key } });
	check('W set up as standby', r.status === 303, `${r.status} ${r.headers.get('location')}`);
	check('W role is standby', (await W.health()).role === 'standby');
	check('W holds S’s cards and reviews', W.count('card') === 4 && W.count('review_event') === 3, `${W.count('card')} cards, ${W.count('review_event')} reviews`);
	await W.login();
	r = await W.req('POST', '/api/cards', { json: { note: { kind: 'basic', fields: { Front: 'x', Back: 'y' } } } });
	check('standby refuses changes', r.status === 409, String(r.status));

	// S learns W's address (so it can notice a newer primary later).
	await S.json('POST', '/api/sync', { action: 'configure', url: W.base, key });

	// --- Outage: S stops. W becomes primary and is studied on.
	await S.stop();
	let p = await W.json('POST', '/api/sync', { action: 'promote' });
	check('W asks to confirm when S is unreachable', p.needsConfirm === true, p.message);
	p = await W.json('POST', '/api/sync', { action: 'promote', force: true });
	check('W is now primary', (await W.health()).role === 'primary', p.message);
	check('W review saved', (await W.reviewOne()) === 'saved');
	await W.json('POST', '/api/cards', { note: { kind: 'basic', fields: { Front: 'Made on Windows', Back: 'during the outage' } } });
	const wReviews = W.count('review_event');
	const wCards = W.count('card');

	// --- S comes back: it must notice W is newer, step down and take W's copy.
	await S.start();
	let role = '';
	for (let i = 0; i < 60 && role !== 'standby'; i++) {
		await sleep(500);
		role = (await S.health()).role;
	}
	check('returning S steps down to standby', role === 'standby', role);
	// Stepping down switches the role first, then downloads W's copy.
	for (let i = 0; i < 40 && !(S.count('review_event') === wReviews && S.count('card') === wCards); i++) await sleep(250);
	check('S now has the work done on W', S.count('review_event') === wReviews && S.count('card') === wCards, `${S.count('review_event')}/${wReviews} reviews, ${S.count('card')}/${wCards} cards`);
	const kept = fs.readdirSync(path.join(S.dataDir, 'kept-aside'));
	check('S kept its own database aside', kept.length > 0, kept.join(', '));
	const sState = await (await S.req('GET', '/settings/sync')).text();
	check('no conflict flagged (S made no changes after W’s copy)', !sState.includes('Both devices took changes'));

	// --- Switch back: make S primary; W hands off cleanly.
	await S.login().catch(() => {});
	p = await S.json('POST', '/api/sync', { action: 'promote' });
	check('S is primary again', (await S.health()).role === 'primary', p.message);
	let wRole = '';
	for (let i = 0; i < 20 && wRole !== 'standby'; i++) {
		await sleep(300);
		wRole = (await W.health()).role;
	}
	check('W went back to standby', wRole === 'standby', wRole);
	check('nothing lost across the round trip', S.count('review_event') === wReviews && S.count('card') === wCards);
	check('S review saved after switching back', (await S.reviewOne()) === 'saved');

	// --- Accident: both machines take changes. S edits after W's last copy, then W is forced primary.
	await W.json('POST', '/api/sync', { action: 'check' }); // W pulls S's latest
	await S.json('POST', '/api/cards', { note: { kind: 'basic', fields: { Front: 'Made on S after W pulled', Back: 'z' } } });
	await S.stop();
	await W.login();
	await W.json('POST', '/api/sync', { action: 'promote', force: true });
	await W.reviewOne();
	await S.start();
	role = '';
	for (let i = 0; i < 60 && role !== 'standby'; i++) {
		await sleep(500);
		role = (await S.health()).role;
	}
	const conflictPage = await (await S.req('GET', '/settings/sync')).text();
	check('both-active conflict is detected on S', conflictPage.includes('Both devices took changes'));
	check('both copies kept (S’s copy set aside)', fs.readdirSync(path.join(S.dataDir, 'kept-aside')).length >= 2);
	const res = await S.json('POST', '/api/sync', { action: 'resolve', choice: 'keep-other' });
	check('owner can choose a copy', res.ok === true, res.message);
} catch (err) {
	failures++;
	console.log('FAIL  exception: ' + (err && err.message ? err.message : err));
	console.log('--- S log ---\n' + S.log.slice(-2000));
	console.log('--- W log ---\n' + W.log.slice(-2000));
} finally {
	await S.stop().catch(() => {});
	await W.stop().catch(() => {});
	console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
	process.exit(failures ? 1 : 0);
}
