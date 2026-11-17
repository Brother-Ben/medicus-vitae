// Medicus Vitae's Jack Westin import. On Jack Westin pages it adds a small
// "Send to Medicus" button. When Medicus opens a page with #medicus=<address>
// (the "Get passage" button in Medicus), it does the same by itself: finds the
// newest passage if it's on the list of passages, waits for it to load, reads
// the passage and every question from the data the page itself holds (on pages
// without that, it steps through the questions, never pressing Submit or End),
// and takes the page to Medicus's import screen. This is your own browser visiting
// the page as you would; nothing gets around the site's checks, and the copy
// goes only to the Medicus address you use.
(() => {
	if (window.__medicusExt) return;
	window.__medicusExt = true;
	// Two copies of the extension (an old one still listed beside a newly added one)
	// each get their own window here but share the page: only the first one runs.
	const root = document.documentElement;
	if (root.hasAttribute('data-medicus-ext')) return;
	root.setAttribute('data-medicus-ext', '');

	const LIST_PATH = '/daily/mcat-practice-passages/cars-practice-passages';
	const store = chrome.storage && chrome.storage.local;
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	function getStored() {
		return new Promise((resolve) => {
			if (!store) return resolve({});
			store.get(['medicusOrigin', 'approved'], (v) => resolve(v || {}));
		});
	}
	function setStored(v) {
		return new Promise((resolve) => (store ? store.set(v, resolve) : resolve()));
	}

	function cleanOrigin(s) {
		try {
			const u = new URL(s);
			if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
			return u.origin;
		} catch (e) {
			return null;
		}
	}
	// Your own machine or home network: no need to ask.
	function isLocal(origin) {
		const h = new URL(origin).hostname;
		return (
			h === 'localhost' ||
			h === '127.0.0.1' ||
			h === '[::1]' ||
			/\.local$/.test(h) ||
			/^10\./.test(h) ||
			/^192\.168\./.test(h) ||
			/^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
			/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h) ||
			/\.ts\.net$/.test(h)
		);
	}
	async function approve(origin) {
		const st = await getStored();
		const approved = Array.isArray(st.approved) ? st.approved : [];
		if (!isLocal(origin) && !approved.includes(origin)) {
			if (!window.confirm(`Send Jack Westin passages to the Medicus Vitae at ${origin}?`)) return false;
			approved.push(origin);
		}
		await setStored({ medicusOrigin: origin, approved });
		return true;
	}

	function hashParams() {
		const h = location.hash.replace(/^#/, '');
		if (!/(^|&)medicus=/.test(h)) return null;
		const p = new URLSearchParams(h);
		return { origin: cleanOrigin(p.get('medicus') || ''), skip: (p.get('skip') || '').split(',').filter(Boolean) };
	}

	const slugOf = (href) => {
		try {
			const u = new URL(href, location.href);
			if (!/jackwestin\.com$/.test(u.hostname)) return null;
			const path = u.pathname.replace(/\/+$/, '');
			if (!path.startsWith(LIST_PATH + '/')) return null;
			const slug = path.slice(LIST_PATH.length + 1);
			if (!slug || slug.includes('/') || /^(page|category|tag)$/i.test(slug)) return null;
			return slug;
		} catch (e) {
			return null;
		}
	};
	const isListPage = () => location.pathname.replace(/\/+$/, '') === LIST_PATH;

	const visible = (el) => {
		if (!el || !(el.offsetWidth || el.offsetHeight || el.getClientRects().length)) return false;
		const s = getComputedStyle(el);
		return s.visibility !== 'hidden' && s.display !== 'none';
	};
	const wordCount = (s) => (s.match(/[A-Za-z’']{2,}/g) || []).length;
	const pageText = () => (document.body && document.body.innerText) || '';

	function looksReady() {
		const t = pageText();
		if (wordCount(t) < 250) return false;
		return document.querySelector('input[type=radio]') || /question\s*1\b/i.test(t) || /^\s*\(?A[.)]\s+\S/m.test(t);
	}

	async function waitFor(test, ms) {
		const end = Date.now() + ms;
		while (Date.now() < end) {
			if (test()) return true;
			await sleep(400);
		}
		return !!test();
	}

	// Controls that go to the next question (never ones that submit or leave the passage).
	// They aren't always buttons: Jack Westin's is a list item, <li data-gtm-element-name="next"><u>N</u>ext</li>.
	const NEXT = /^(next|next question|continue|›|»|→|>)$/i;
	const AVOID = /submit|finish|grade|check answers?|end|review|next passage|next article|previous|back|prev/i;
	const labelOf = (el) => ((el.innerText || el.textContent || '').trim() || el.getAttribute('aria-label') || el.title || '').trim();
	function nextControl() {
		const marked = document.querySelector('[data-gtm-element-name="next"]');
		if (marked && visible(marked) && NEXT.test(labelOf(marked))) return marked;
		const els = document.querySelectorAll('button, [role=button], a:not([href]), a[href="#"], a[href^="javascript"], li, [onclick], [tabindex]');
		for (const el of els) {
			if (el === button || !visible(el) || el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
			const label = labelOf(el);
			if (!label || label.length > 40 || AVOID.test(label)) continue;
			if (NEXT.test(label) || /next question/i.test(el.getAttribute('aria-label') || '')) return el;
		}
		return null;
	}
	function numberControls() {
		const found = new Map();
		// Only controls that stay on the page (links could be page numbers that leave it).
		for (const el of document.querySelectorAll('button, [role=button], [role=tab]')) {
			if (!visible(el) || el.disabled) continue;
			const m = /^(?:q(?:uestion)?\s*)?(\d{1,2})$/i.exec((el.innerText || el.textContent || '').trim());
			if (m && !found.has(Number(m[1]))) found.set(Number(m[1]), el);
		}
		return found.has(1) && found.has(2) && found.size >= 3 ? [...found.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]) : [];
	}

	// What's new on screen after a click: the next question and its choices.
	async function stepThroughQuestions() {
		const seen = new Set(pageText().split('\n').map((l) => l.trim()).filter(Boolean));
		const steps = [];
		const grab = async () => {
			let lines = [];
			await waitFor(() => {
				lines = pageText()
					.split('\n')
					.map((l) => l.trim())
					.filter((l) => l && !seen.has(l) && !(button && l === button.textContent));
				return lines.length > 0;
			}, 3000);
			if (!lines.length) return false;
			for (const l of lines) seen.add(l);
			steps.push(lines.join('\n'));
			return true;
		};
		const numbers = numberControls();
		if (numbers.length) {
			for (const el of numbers.slice(1, 15)) {
				el.click();
				await sleep(500);
				await grab();
			}
			return steps;
		}
		for (let i = 0; i < 14; i++) {
			const el = nextControl();
			if (!el) break;
			el.click();
			await sleep(500);
			if (!(await grab())) break;
		}
		return steps;
	}

	// The page's own data, from page-data.js, and how many questions it holds.
	function pageData() {
		return new Promise((resolve) => {
			const id = Math.random().toString(36).slice(2);
			const done = (v) => {
				window.removeEventListener('message', onMsg);
				resolve(v);
			};
			const onMsg = (e) => {
				if (e.source === window && e.data && e.data.source === 'medicus-page' && e.data.id === id) done({ data: e.data.data || null, questions: Number(e.data.questions) || 0 });
			};
			window.addEventListener('message', onMsg);
			window.postMessage({ source: 'medicus-ext', type: 'collect', id }, '*');
			setTimeout(() => done({ data: null, questions: 0 }), 4000);
		});
	}

	// Browsers take addresses up to about 2 MB: drop the bulkiest, least useful parts until it fits.
	const MAX_LINK = 1_900_000;
	async function encodeToFit(cap) {
		let enc = await encode(cap);
		if (enc.length <= MAX_LINK) return enc;
		const slim = (keep) => {
			try {
				const d = JSON.parse(cap.data);
				return JSON.stringify({ medicusParts: d.medicusParts.filter((p) => keep.includes(p.from)) });
			} catch (e) {
				return null;
			}
		};
		const tries = [
			{ ...cap, html: '' },
			{ ...cap, html: '', data: cap.data && slim(['jw-daily', 'response', 'nuxt-payload', 'pinia', '__NUXT_DATA__', '__NEXT_DATA__', 'nuxt2']) },
			{ ...cap, html: '', data: cap.data && slim(['jw-daily', 'response', 'nuxt-payload']) },
			{ ...cap, html: '', data: cap.data && slim(['jw-daily']) },
			{ ...cap, html: '', data: null }
		];
		for (const t of tries) {
			enc = await encode(t);
			if (enc.length <= MAX_LINK) return enc;
		}
		return encode({ ...cap, html: '', data: null, text: cap.text.slice(0, 60000), frames: cap.frames.slice(0, 15) });
	}

	async function encode(obj) {
		const json = JSON.stringify(obj);
		try {
			const gz = new Blob([json]).stream().pipeThrough(new CompressionStream('gzip'));
			const buf = new Uint8Array(await new Response(gz).arrayBuffer());
			let bin = '';
			for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
			return 'gz.' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
		} catch (e) {
			return 'js.' + encodeURIComponent(json);
		}
	}

	async function capture() {
		// The page as it is, without this extension's own button.
		if (button) button.style.display = 'none';
		let text = '';
		try {
			text = pageText();
		} finally {
			if (button) button.style.display = '';
		}
		const big = (el) => (el && (el.innerText || '').length > 1200 ? el : null);
		const root = big(document.querySelector('main')) || big(document.querySelector('article')) || big(document.querySelector('#__nuxt')) || document.body;
		const html = (root.innerHTML || '').slice(0, 600000);
		let found = await pageData();
		// When the page's data already has every question (Jack Westin's does), nothing
		// needs clicking. Otherwise step through them and read the data again.
		let steps = [];
		if (found.questions < 2) {
			steps = await stepThroughQuestions();
			found = await pageData();
		}
		const data = found.data;
		return {
			v: 3,
			via: 'extension',
			url: location.href.replace(/#.*$/, ''),
			title: document.title,
			text: text.slice(0, 250000),
			html,
			data: data && data.length < 8_000_000 ? data : null,
			frames: steps.map((s) => s.slice(0, 40000)),
			at: Date.now()
		};
	}

	let busy = false;
	async function send(origin, sameTab) {
		if (busy) return;
		busy = true;
		setButton('Reading the passage…');
		try {
			await waitFor(looksReady, 25000);
			await sleep(600);
			const cap = await capture();
			const url = origin + '/import/cars#' + (await encodeToFit(cap));
			setButton('Sent');
			if (sameTab) location.replace(url);
			else if (!window.open(url, '_blank')) location.href = url;
		} catch (err) {
			setButton('Send to Medicus');
			window.alert('Medicus couldn’t read this page: ' + (err && err.message ? err.message : err));
		} finally {
			busy = false;
			setTimeout(() => setButton('Send to Medicus'), 4000);
		}
	}

	// ------------------------------------------------------------ the button
	let button = null;
	function setButton(label) {
		if (button) button.textContent = label;
	}
	function addButton() {
		if (button || !document.body) return;
		button = document.createElement('button');
		button.type = 'button';
		button.textContent = 'Send to Medicus';
		button.setAttribute('aria-label', 'Send this passage to Medicus Vitae');
		Object.assign(button.style, {
			position: 'fixed',
			right: '16px',
			bottom: '16px',
			zIndex: '2147483646',
			padding: '9px 14px',
			border: '0',
			borderRadius: '8px',
			background: '#1f2a44',
			color: '#fff',
			font: '600 13px system-ui, -apple-system, Segoe UI, sans-serif',
			boxShadow: '0 4px 14px rgba(0,0,0,.25)',
			cursor: 'pointer'
		});
		button.addEventListener('click', async () => {
			const st = await getStored();
			let origin = cleanOrigin(st.medicusOrigin || '');
			if (!origin) {
				const typed = window.prompt('Your Medicus Vitae address (as in its address bar):', 'http://localhost:8080');
				origin = cleanOrigin(typed || '');
				if (!origin) return;
			}
			if (!(await approve(origin))) return;
			send(origin, false);
		});
		document.body.appendChild(button);
	}

	// ------------------------------------------------------------ one click from Medicus
	async function auto() {
		const p = hashParams();
		if (!p || !p.origin) return false;
		if (!(await approve(p.origin))) return true;
		if (isListPage()) {
			setButton('Finding the newest passage…');
			let target = null;
			// The list itself (in <main>) first, so a sidebar of popular passages doesn't win.
			await waitFor(() => {
				for (const scope of [document.querySelector('main'), document]) {
					if (!scope) continue;
					for (const a of scope.querySelectorAll('a[href]')) {
						const slug = slugOf(a.href);
						if (slug && !p.skip.includes(slug)) {
							target = a.href.replace(/#.*$/, '');
							return true;
						}
					}
				}
				return false;
			}, 20000);
			if (!target) {
				setButton('Send to Medicus');
				window.alert('Medicus couldn’t find a passage on this page. Open one and press “Send to Medicus”.');
				return true;
			}
			location.href = target + '#medicus=' + encodeURIComponent(p.origin);
			return true;
		}
		send(p.origin, true);
		return true;
	}

	addButton();
	auto();
})();
