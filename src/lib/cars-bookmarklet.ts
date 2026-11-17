// The "Send to Medicus" bookmark (a bookmarklet). Pressed on a CARS passage
// page, it copies what that page shows (all of its text, the HTML of its main
// part and the app state the site ships with: on Jack Westin, window.dailyData,
// which has every question and the answer key) and opens Medicus with it in the address's
// #fragment, which never goes to any server. Nothing else is read or sent, and it
// runs only when pressed: the owner's own browser is the one visiting the site.

function source(origin: string): string {
	return `(async () => {
  const MEDICUS = ${JSON.stringify(origin)};
  const big = (el) => (el && (el.innerText || '').length > 1200 ? el : null);
  const root = big(document.querySelector('main')) || big(document.querySelector('article')) || big(document.querySelector('[role=main]')) || big(document.querySelector('#__nuxt')) || document.body;
  const seen = new WeakSet();
  const json = (v) => { try { return JSON.stringify(v, (k, x) => { if (typeof x === 'function') return undefined; if (x && typeof x === 'object') { if (seen.has(x)) return undefined; seen.add(x); } return x; }); } catch (e) { return null; } };
  let data = null;
  try { const d = window.dailyData; if (d && Array.isArray(d.questions)) data = json({ medicusParts: [{ from: 'jw-daily', value: { title: d.title, questions: d.questions.map((q) => ({ question: q.question, solution: q.solution, options: q.options, correct_answer: q.correct_answer, answer_a: q.answer_a, answer_b: q.answer_b, answer_c: q.answer_c, answer_d: q.answer_d, passage: q.passage && { id: q.passage.id, passage: q.passage.passage }, tags: (q.tags || []).map((t) => ({ name: t && t.name })) })) } }] }); } catch (e) {}
  if (!data) try { const app = document.querySelector('#__nuxt') && document.querySelector('#__nuxt').__vue_app__; const p = app && app.config && app.config.globalProperties && app.config.globalProperties.$nuxt && app.config.globalProperties.$nuxt.payload; if (p) data = json(p); } catch (e) {}
  if (!data) { try { if (window.__NUXT__) data = json(window.__NUXT__); } catch (e) {} }
  if (!data) { const s = document.getElementById('__NUXT_DATA__') || document.getElementById('__NEXT_DATA__'); if (s) data = s.textContent; }
  const frames = [];
  document.querySelectorAll('iframe').forEach((f) => { try { const t = f.contentDocument && f.contentDocument.body && f.contentDocument.body.innerText; if (t && t.length > 400) frames.push(t.slice(0, 150000)); } catch (e) {} });
  const page = { v: 2, url: location.href, title: document.title, text: (document.body.innerText || '').slice(0, 250000), html: (root.innerHTML || '').slice(0, 600000), data: data ? data.slice(0, 2000000) : null, frames: frames, at: Date.now() };
  let enc;
  try {
    const gz = new Blob([JSON.stringify(page)]).stream().pipeThrough(new CompressionStream('gzip'));
    const buf = new Uint8Array(await new Response(gz).arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 32768) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 32768));
    enc = 'gz.' + btoa(bin).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
  } catch (e) {
    page.html = ''; page.data = null;
    enc = 'js.' + encodeURIComponent(JSON.stringify(page));
  }
  const url = MEDICUS + '/import/cars#' + enc;
  const w = window.open(url, '_blank');
  if (!w) location.href = url;
})();`;
}

/** The bookmark's address, for an <a href> the owner drags to the bookmarks bar. */
export function bookmarkletFor(origin: string): string {
	const code = source(origin.replace(/\/+$/, ''))
		.split('\n')
		.map((l) => l.trim())
		.join(' ');
	return 'javascript:' + encodeURIComponent(code);
}
