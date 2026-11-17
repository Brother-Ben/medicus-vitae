// Code that runs inside the card frame (AnkiCard.svelte), before the card's own
// HTML. The frame is sandboxed with an opaque origin: the card's scripts can run
// (many Anki note types build the card with JavaScript) but can't reach Cortex,
// its storage or the sign-in. This gives them what Anki's reviewer provides:
//  - localStorage/sessionStorage (in memory, kept by the page between cards)
//  - onUpdateHook / onShownHook, pycmd('ans'), a MathJax stand-in (math is
//    already typeset on the server with KaTeX)
//  - anki.imageOcclusion.setup(): draws image occlusion masks
// and reports the card's height, key presses and color scheme to the page.
//
// Written as ES5-style source in a template string: it is inserted into the
// frame's srcdoc as is.

export interface FrameRuntimeOptions {
	nonce: string;
	dark: boolean;
	text: string;
	store: { localStorage: Record<string, string>; sessionStorage: Record<string, string> };
}

function json(v: unknown) {
	// Safe inside <script>: no "</script" or "<!--" can be formed.
	return JSON.stringify(v).replace(/</g, '\\u003c');
}

export function frameRuntime(o: FrameRuntimeOptions): string {
	return `(function () {
var NONCE = ${json(o.nonce)}, DARK = ${o.dark ? 'true' : 'false'}, TEXT = ${json(o.text)}, STORE = ${json(o.store)};
function post(msg) { msg.cortexCard = NONCE; try { parent.postMessage(msg, '*'); } catch (e) {} }
window.__cortexPost = post;

function makeStorage(kind) {
	var data = Object.create(null), initial = STORE[kind] || {};
	for (var k in initial) data[k] = String(initial[k]);
	return {
		getItem: function (k) { k = String(k); return k in data ? data[k] : null; },
		setItem: function (k, v) { k = String(k); v = String(v); data[k] = v; post({ op: 'store', kind: kind, key: k, value: v }); },
		removeItem: function (k) { k = String(k); delete data[k]; post({ op: 'store', kind: kind, key: k, value: null }); },
		clear: function () { for (var k in data) delete data[k]; post({ op: 'store-clear', kind: kind }); },
		key: function (i) { var keys = Object.keys(data); return i < keys.length ? keys[i] : null; },
		get length() { return Object.keys(data).length; }
	};
}
['localStorage', 'sessionStorage'].forEach(function (name) {
	var works = false;
	try { works = !!window[name] && window[name].length >= 0; } catch (e) {}
	if (!works) { try { Object.defineProperty(window, name, { value: makeStorage(name), configurable: true }); } catch (e) {} }
});

window.onUpdateHook = [];
window.onShownHook = [];
window.ankiPlatform = 'desktop';
window.pycmd = window.bridgeCommand = function (cmd) { if (cmd === 'ans') post({ op: 'reveal' }); return false; };
if (!window.MathJax) {
	var done = function () { return Promise.resolve(); };
	window.MathJax = { typeset: function () {}, typesetPromise: done, typesetClear: function () {}, startup: { promise: done() },
		Hub: { Queue: function () {}, Typeset: function () {}, Config: function () {} } };
}

document.addEventListener('keydown', function (e) {
	var t = e.target;
	if (t && (t.isContentEditable || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && t.type !== 'range' && t.type !== 'checkbox' && t.type !== 'button'))) return;
	post({ op: 'key', key: e.key, code: e.code, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey });
}, true);

// ------------------------------------------------------------ size
// Measured from where the content ends rather than the page height, so a card
// styled with min-height: 100vh doesn't keep growing the frame.
var lastHeight = 0;
function report() {
	var b = document.body;
	if (!b) return;
	// Elements fixed to the bottom (Anki tag bars) would cover the last line: leave room for them.
	var bottom = 0, fixed = [], all = b.querySelectorAll('*');
	for (var i = 0; i < all.length && i < 3000; i++) {
		var s = getComputedStyle(all[i]);
		if (s.position !== 'fixed' || s.display === 'none') continue;
		fixed.push(all[i]);
		if (s.visibility !== 'hidden' && s.bottom !== 'auto') bottom = Math.max(bottom, all[i].getBoundingClientRect().height);
	}
	var pad = bottom ? Math.ceil(bottom) + 'px' : '';
	if (b.style.paddingBottom !== pad) b.style.paddingBottom = pad;
	// Fixed elements sit at the frame's edges, outside the flow: measuring them would
	// grow the frame, move them down, and grow it again. Leave them out.
	var saved = fixed.map(function (el) {
		var x = [el, el.style.getPropertyValue('display'), el.style.getPropertyPriority('display')];
		el.style.setProperty('display', 'none', 'important');
		return x;
	});
	var range = document.createRange();
	range.selectNodeContents(b);
	var cs = getComputedStyle(b);
	var end = range.getBoundingClientRect().bottom + window.scrollY;
	saved.forEach(function (x) {
		if (x[1]) x[0].style.setProperty('display', x[1], x[2]);
		else x[0].style.removeProperty('display');
	});
	var h = Math.ceil(end + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0) + (parseFloat(cs.marginBottom) || 0));
	h = Math.max(h, 24);
	if (Math.abs(h - lastHeight) > 1) { lastHeight = h; post({ op: 'size', height: h }); }
}
var pending = false;
function soon() { if (!pending) { pending = true; requestAnimationFrame(function () { pending = false; report(); }); } }
try { new ResizeObserver(soon).observe(document.documentElement); } catch (e) {}
document.addEventListener('load', soon, true);
window.addEventListener('load', function () { report(); setTimeout(report, 300); });

// ------------------------------------------------------- colors
// Decks styled with Anki's defaults (white card, black text) blend into the
// app's theme; decks with their own background keep it, as in Anki.
function rgba(c) {
	var m = /rgba?\\(([^)]+)\\)/.exec(c || '');
	if (!m) return null;
	var p = m[1].split(/[\\s,\\/]+/).filter(Boolean).map(parseFloat);
	return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
}
function luminance(c) {
	var f = function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
	return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}
function adaptColors() {
	var b = document.body, s = getComputedStyle(b), bg = rgba(s.backgroundColor), fg = rgba(s.color);
	var own = !!bg && bg.a > 0.05 && luminance(bg) < 0.85;
	if (!own) {
		b.style.setProperty('background-color', 'transparent', 'important');
		document.documentElement.style.setProperty('background-color', 'transparent', 'important');
		if (DARK && fg && luminance(fg) < 0.3) b.style.setProperty('color', TEXT, 'important');
	}
	post({ op: 'style', own: own, background: own ? s.backgroundColor : null });
}

function runHooks(list) {
	for (var i = 0; i < list.length; i++) { try { var r = list[i](); if (r && r.then) r.then(soon, soon); } catch (e) { console.error(e); } }
}
document.addEventListener('DOMContentLoaded', function () {
	if (window.innerWidth < 600) document.body.classList.add('mobile');
	adaptColors();
	runHooks(window.onUpdateHook);
	requestAnimationFrame(function () { runHooks(window.onShownHook); report(); });
});

// --------------------------------------------- image occlusion
// Masks come from {{cloze:Occlusion}} as divs with data-shape, data-left, … (see
// cloze.ts); coordinates are fractions of the image (or pixels in old notes).
function shapesOf(selector, kind) {
	var out = [], els = document.querySelectorAll(selector);
	for (var i = 0; i < els.length; i++) {
		var d = els[i].dataset;
		if (!d.shape) continue;
		out.push({ kind: kind, shape: d.shape, left: +d.left || 0, top: +d.top || 0, width: +d.width || 0, height: +d.height || 0,
			rx: +d.rx || 0, ry: +d.ry || 0, points: d.points || '', angle: +d.angle || 0, text: d.text || '', scale: +d.scale || 1,
			fontSize: +d.fontSize || 0, fill: d.fill || '', occludeInactive: d.occludeinactive === '1' || d.occludeinactive === 'true' });
	}
	return out;
}
function border(spec, fallbackColor) {
	var parts = String(spec || '').trim().split(/\\s+/), width = 1, color = fallbackColor;
	for (var i = 0; i < parts.length; i++) { if (/^[\\d.]+px$/.test(parts[i])) width = parseFloat(parts[i]); else if (parts[i]) color = parts[i]; }
	return { width: width, color: color };
}
function setupImageOcclusion() {
	var container = document.getElementById('image-occlusion-container');
	var canvas = document.getElementById('image-occlusion-canvas');
	if (!container || !canvas) return;
	var img = container.querySelector('img');
	if (!img) { container.insertAdjacentHTML('beforeend', '<div class="card-problem">This image occlusion card has no image.</div>'); return; }
	if (!img.complete || !img.naturalWidth) { img.addEventListener('load', setupImageOcclusion, { once: true }); return; }
	if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
	canvas.style.position = 'absolute';
	canvas.style.pointerEvents = 'none';
	var draw = function () {
		var w = img.clientWidth, h = img.clientHeight, ratio = window.devicePixelRatio || 1;
		if (!w || !h) return;
		canvas.width = Math.round(w * ratio);
		canvas.height = Math.round(h * ratio);
		canvas.style.width = w + 'px';
		canvas.style.height = h + 'px';
		canvas.style.left = img.offsetLeft + 'px';
		canvas.style.top = img.offsetTop + 'px';
		var ctx = canvas.getContext('2d');
		ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
		ctx.clearRect(0, 0, w, h);
		var cs = getComputedStyle(canvas), v = function (n, f) { return cs.getPropertyValue(n).trim() || f; };
		var styles = {
			active: { fill: v('--active-shape-color', '#ff8e8e'), border: border(v('--active-shape-border', '1px #212121'), '#212121') },
			inactive: { fill: v('--inactive-shape-color', '#ffeba2'), border: border(v('--inactive-shape-border', '1px #212121'), '#212121') },
			highlight: { fill: v('--highlight-shape-color', 'rgba(255,142,142,0)'), border: border(v('--highlight-shape-border', '1px #ff8e8e'), '#ff8e8e') }
		};
		var shapes = shapesOf('.cloze', 'active').concat(shapesOf('.cloze-inactive', 'inactive'), shapesOf('.cloze-highlight', 'highlight'));
		var nw = img.naturalWidth || w, nh = img.naturalHeight || h;
		shapes.forEach(function (s) {
			if (s.kind === 'inactive' && !s.occludeInactive && s.shape !== 'text') return;
			var pixels = s.left > 1.5 || s.top > 1.5 || s.width > 1.5 || s.height > 1.5;
			var sx = pixels ? w / nw : w, sy = pixels ? h / nh : h;
			var st = styles[s.kind];
			ctx.save();
			ctx.translate(s.left * sx, s.top * sy);
			if (s.angle) ctx.rotate((s.angle * Math.PI) / 180);
			ctx.beginPath();
			if (s.shape === 'rect') ctx.rect(0, 0, s.width * sx, s.height * sy);
			else if (s.shape === 'ellipse') ctx.ellipse(s.rx * sx, s.ry * sy, Math.max(0.5, s.rx * sx), Math.max(0.5, s.ry * sy), 0, 0, Math.PI * 2);
			else if (s.shape === 'polygon') {
				var pts = s.points.trim().split(/\\s+/).map(function (p) { var xy = p.split(','); return [(+xy[0] || 0) * sx - s.left * sx, (+xy[1] || 0) * sy - s.top * sy]; });
				pts.forEach(function (p, i) { if (i) ctx.lineTo(p[0], p[1]); else ctx.moveTo(p[0], p[1]); });
				ctx.closePath();
			} else if (s.shape === 'text') {
				var size = (s.fontSize || 20) * s.scale * (pixels ? w / nw : w / Math.max(1, nw));
				ctx.font = Math.max(8, size) + 'px Arial, sans-serif';
				ctx.textBaseline = 'top';
				ctx.lineWidth = 3;
				ctx.strokeStyle = 'rgba(255,255,255,0.9)';
				s.text.split('\\n').forEach(function (line, i) { ctx.strokeText(line, 0, i * size * 1.2); ctx.fillStyle = '#000'; ctx.fillText(line, 0, i * size * 1.2); });
				ctx.restore();
				return;
			}
			ctx.fillStyle = s.fill || st.fill;
			ctx.fill();
			if (st.border.width > 0) { ctx.lineWidth = st.border.width; ctx.strokeStyle = st.border.color; ctx.stroke(); }
			ctx.restore();
		});
		soon();
	};
	draw();
	window.addEventListener('resize', draw);
	var toggle = document.getElementById('toggle');
	if (toggle) toggle.addEventListener('click', function () { canvas.style.visibility = canvas.style.visibility === 'hidden' ? '' : 'hidden'; });
}
window.anki = window.anki || {};
window.anki.imageOcclusion = { setup: function () {
	if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setupImageOcclusion);
	else setupImageOcclusion();
} };
})();`;
}
