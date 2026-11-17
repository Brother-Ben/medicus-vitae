// Makes Medicus Vitae installable as an app (PLAT-01). Caches only the app's own
// code and static files; pages and your data always come from the server.
// Offline reviews arrive in a later version (PLAT-04).

import { self } from '$app/service-worker';
import { version } from '$app/env';
import { assets, immutable } from '$app/manifest';
import { resolve } from '$app/paths';

const CACHE = `cortex-${version}`;
const PRECACHE = [
	...immutable.map((f) => resolve(f.path as never)),
	...assets.filter((f) => !f.path.startsWith('pdfjs/')).map((f) => resolve(f.path as never))
] as string[];

const OFFLINE_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Medicus Vitae is offline</title>
<style>/* Standalone page (the app's styles can't load offline): Clinic Light / Clinic Dark colors from themes.css. */
:root{--bg:#F3F6F5;--text:#13201F;--accent:#0F766E;--on-accent:#FFFFFF}
@media (prefers-color-scheme:dark){:root{--bg:#0E1413;--text:#E5EDEB;--accent:#2BB3A3;--on-accent:#05201C}}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font-family:system-ui,sans-serif;background:var(--bg);color:var(--text)}
div{max-width:26rem;padding:1.5rem;text-align:center}
b{display:inline-flex;width:48px;height:48px;border-radius:12px;background:var(--accent);color:var(--on-accent);align-items:center;justify-content:center;font-size:1.5rem}</style></head>
<body><div><b>M</b><h1>Medicus Vitae is offline</h1><p>Can’t reach your Medicus Vitae server. Check that it is running and that this device is connected to Tailscale, then reload.</p></div></body></html>`;

self.addEventListener('install', (event) => {
	event.waitUntil(
		caches
			.open(CACHE)
			.then((cache) => cache.addAll(PRECACHE))
			.then(() => self.skipWaiting())
	);
});

self.addEventListener('activate', (event) => {
	event.waitUntil(
		caches
			.keys()
			.then((keys) => Promise.all(keys.filter((k) => k !== CACHE && k.startsWith('cortex-')).map((k) => caches.delete(k))))
			.then(() => self.clients.claim())
	);
});

self.addEventListener('fetch', (event) => {
	const req = event.request;
	if (req.method !== 'GET') return;
	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return;

	if (PRECACHE.includes(url.pathname)) {
		event.respondWith(caches.match(url.pathname).then((hit) => hit ?? fetch(req)));
		return;
	}
	if (url.pathname.startsWith('/pdfjs/')) {
		event.respondWith(
			caches.open(CACHE).then(async (cache) => {
				const hit = await cache.match(req);
				if (hit) return hit;
				const res = await fetch(req);
				if (res.ok) void cache.put(req, res.clone());
				return res;
			})
		);
		return;
	}
	if (req.mode === 'navigate') {
		event.respondWith(
			fetch(req).catch(() => new Response(OFFLINE_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } }))
		);
	}
});
