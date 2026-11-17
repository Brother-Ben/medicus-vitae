// Runs inside Jack Westin's page (its own JavaScript world), from the moment the
// page starts loading. It keeps a copy of the data the page itself loads for the
// passage (questions, choices, answers once shown), and on request hands that,
// plus the app state the page was built from, to content.js. Nothing is sent
// anywhere from here, and nothing on the page is changed.
(() => {
	if (window.__medicusPageData) return;
	window.__medicusPageData = true;

	const responses = [];
	let kept = 0;
	const MAX_ONE = 3_000_000;
	const MAX_ALL = 12_000_000;

	function keep(url, text) {
		if (typeof text !== 'string' || !text || text.length > MAX_ONE || kept + text.length > MAX_ALL) return;
		const t = text.trim();
		if (t[0] !== '{' && t[0] !== '[') return;
		if (!/question|answer|passage|choice|option/i.test(t)) return;
		try {
			responses.push({ url: String(url || '').slice(0, 500), value: JSON.parse(t) });
			kept += t.length;
		} catch (e) {
			/* not JSON after all */
		}
	}

	const origFetch = window.fetch;
	if (typeof origFetch === 'function') {
		window.fetch = function (...args) {
			const p = origFetch.apply(this, args);
			p.then(
				(res) => {
					try {
						const ct = (res.headers && res.headers.get('content-type')) || '';
						if (/json|text\/plain/i.test(ct)) res.clone().text().then((t) => keep(res.url, t), () => {});
					} catch (e) {
						/* ignore */
					}
				},
				() => {}
			);
			return p;
		};
	}

	const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
	if (XHR) {
		const open = XHR.open;
		const send = XHR.send;
		XHR.open = function (method, url, ...rest) {
			this.__medicusUrl = url;
			return open.call(this, method, url, ...rest);
		};
		XHR.send = function (...args) {
			this.addEventListener('load', () => {
				try {
					if (this.responseType === '' || this.responseType === 'text') keep(this.__medicusUrl, this.responseText);
					else if (this.responseType === 'json' && this.response) keep(this.__medicusUrl, JSON.stringify(this.response));
				} catch (e) {
					/* ignore */
				}
			});
			return send.apply(this, args);
		};
	}

	// A plain copy of a value: no functions, no loops, not too big.
	function plain(v, limit) {
		const seen = new WeakSet();
		try {
			const s = JSON.stringify(v, (k, x) => {
				if (typeof x === 'function' || typeof x === 'symbol') return undefined;
				if (typeof Node !== 'undefined' && x instanceof Node) return undefined;
				if (x && typeof x === 'object') {
					if (seen.has(x)) return undefined;
					seen.add(x);
				}
				return x;
			});
			if (!s || s.length > limit) return null;
			plain.last = s.length;
			return JSON.parse(s);
		} catch (e) {
			return null;
		}
	}

	// The state of the page's Vue components (sites built with Nuxt keep a passage's questions there).
	function components(app) {
		const out = [];
		let size = 0;
		const visitInstance = (inst, depth) => {
			if (!inst || out.length >= 400 || depth > 80 || size > 6_000_000) return;
			const pick = {};
			try {
				if (inst.setupState && Object.keys(inst.setupState).length) pick.setup = inst.setupState;
			} catch (e) {}
			try {
				if (inst.data && Object.keys(inst.data).length) pick.data = inst.data;
			} catch (e) {}
			try {
				if (inst.props && Object.keys(inst.props).length) pick.props = inst.props;
			} catch (e) {}
			if (Object.keys(pick).length) {
				const v = plain(pick, 800_000);
				if (v) {
					out.push(v);
					size += plain.last || 0;
				}
			}
			visitNode(inst.subTree, depth + 1);
		};
		const visitNode = (vnode, depth) => {
			if (!vnode || depth > 80) return;
			if (vnode.component) return visitInstance(vnode.component, depth);
			if (vnode.suspense && vnode.suspense.activeBranch) visitNode(vnode.suspense.activeBranch, depth + 1);
			if (Array.isArray(vnode.children)) for (const c of vnode.children) if (c && typeof c === 'object') visitNode(c, depth + 1);
			if (Array.isArray(vnode.dynamicChildren)) for (const c of vnode.dynamicChildren) if (c && typeof c === 'object') visitNode(c, depth + 1);
		};
		try {
			visitInstance(app._instance, 0);
		} catch (e) {}
		return out;
	}

	// Jack Westin's passage pages hold the whole set in window.dailyData: the passage,
	// every question and choice, the answer key and the explanations. Only those
	// are copied (not your account details or what you picked on the site).
	function jwDaily() {
		const d = window.dailyData;
		if (!d || typeof d !== 'object' || !Array.isArray(d.questions)) return null;
		const pick = (o, keys) => {
			const out = {};
			for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) out[k] = o[k];
			return out;
		};
		const letters = ['a', 'b', 'c', 'd', 'e', 'f'];
		const qKeys = ['id', 'question', 'solution', 'options', 'correct_answer', 'difficulty', ...letters.flatMap((l) => [`answer_${l}`, `answer_${l}_content`])];
		return plain(
			{
				title: d.title,
				section_title: d.section_title,
				number_of_questions: d.number_of_questions,
				questions: d.questions.map((q) => ({
					...pick(q, qKeys),
					passage: q && q.passage && typeof q.passage === 'object' ? pick(q.passage, ['id', 'title', 'passage']) : q && q.passage,
					tags: q && Array.isArray(q.tags) ? q.tags.map((t) => pick(t, ['name'])) : []
				}))
			},
			4_000_000
		);
	}

	function collect() {
		const parts = [];
		try {
			const jw = jwDaily();
			if (jw) parts.push({ from: 'jw-daily', value: jw });
		} catch (e) {}
		try {
			const el = document.querySelector('#__nuxt') || document.querySelector('[data-v-app]');
			const app = el && el.__vue_app__;
			const gp = app && app.config && app.config.globalProperties;
			const nuxt = gp && gp.$nuxt;
			if (nuxt && nuxt.payload) parts.push({ from: 'nuxt-payload', value: plain(nuxt.payload, 4_000_000) });
			const pinia = (gp && gp.$pinia) || (nuxt && nuxt.$pinia);
			if (pinia && pinia.state) parts.push({ from: 'pinia', value: plain(pinia.state.value, 4_000_000) });
			if (app) for (const c of components(app)) parts.push({ from: 'component', value: c });
		} catch (e) {}
		try {
			if (window.__NUXT__) parts.push({ from: 'nuxt2', value: plain(window.__NUXT__, 4_000_000) });
		} catch (e) {}
		for (const id of ['__NUXT_DATA__', '__NEXT_DATA__']) {
			try {
				const s = document.getElementById(id);
				if (s && s.textContent) parts.push({ from: id, value: JSON.parse(s.textContent) });
			} catch (e) {}
		}
		for (const r of responses) parts.push({ from: 'response', url: r.url, value: r.value });
		return JSON.stringify({ medicusParts: parts.filter((p) => p.value != null) });
	}

	window.addEventListener('message', (e) => {
		if (e.source !== window || !e.data || e.data.source !== 'medicus-ext' || e.data.type !== 'collect') return;
		let data = null;
		// How many questions the page's own data already holds (then nothing needs clicking).
		let questions = 0;
		try {
			data = collect();
			const d = window.dailyData;
			questions = d && Array.isArray(d.questions) ? d.questions.length : 0;
		} catch (err) {
			data = null;
		}
		window.postMessage({ source: 'medicus-page', type: 'collected', id: e.data.id, data, questions }, '*');
	});
})();
