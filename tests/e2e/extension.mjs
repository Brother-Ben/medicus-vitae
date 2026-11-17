// Drives the Brave/Chrome extension (browser-extension/) on stand-in Jack Westin
// pages, modeled on a real passage page saved on 2026-11-07:
//  - a list of passages;
//  - a passage page like Jack Westin's: the whole set in window.dailyData, one
//    question on screen at a time, and <li> controls (Previous, Next, End) instead
//    of buttons, with Next hidden on the last question;
//  - the same layout without the data (the extension has to step through it);
//  - a generic page that loads its questions from a data request and has a
//    Next and a Submit button.
// Checks the one-click flow end to end (list → newest passage not imported yet →
// Medicus import link) and that End or Submit is never pressed.
//   node tests/e2e/extension.mjs <projectRoot>
// Uses Microsoft Edge through playwright-core; nothing reaches the real site.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { chromium } from 'playwright-core';

const root = path.resolve(process.argv[2] ?? '.');
const ext = path.join(root, 'browser-extension');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'medicus-ext-'));
const MEDICUS = 'http://localhost:8999';
const LIST = 'https://jackwestin.com/daily/mcat-practice-passages/cars-practice-passages/';

let failures = 0;
const check = (name, ok, detail = '') => {
	console.log(`${ok ? '  ✓' : '  ✗'} ${name}${ok || !detail ? '' : ` (${detail})`}`);
	if (!ok) failures++;
};

const words = 'The author argues that rituals persist even when their original purposes fade, because communities find new meanings in old forms and practices'.split(' ');
const para = (n) => Array.from({ length: 120 }, (_, i) => words[(i + n) % words.length]).join(' ') + '.';
const passageHtml = `<p class="hidden"><strong>Passage 1 (Questions 1-3)</strong></p><p>&nbsp;${para(0)}</p><p>&nbsp;${para(3)}</p><p>&nbsp;${para(7)}</p>`;
const stem = (n) => `Question ${n}: Which claim would the author most likely accept (${n})?`;

// Jack Westin's window.dailyData, with its field names (and account details the extension must leave behind).
const jwData = {
	id: 23740914,
	user_id: 542177,
	hash_id: '542177-secret-hash',
	title: 'Ritual Failures',
	number_of_questions: 3,
	questions: [1, 2, 3].map((n) => ({
		id: 4268 + n,
		question: `<p>${stem(n)}</p>`,
		solution: `<p>Explanation ${n}.</p>`,
		options: ['a', 'b', 'c', 'd'].map((l) => ({ key: `answer_${l}`, value: `<p>Choice ${l.toUpperCase()} ${n}</p>`, layout: 'wysiwyg' })),
		...Object.fromEntries(['a', 'b', 'c', 'd'].map((l) => [`answer_${l}`, `Choice ${l.toUpperCase()} ${n}`])),
		correct_answer: 'abcd'[n],
		selected_answer: 'answer_b',
		previous_answer: 'answer_a',
		passage: { id: 869, title: 'Passage 1', passage: passageHtml },
		tags: [{ id: 294, name: 'Religion' }]
	}))
};

// The exam screen: passage on the left, one question on the right, footer of <li> controls.
const examPage = (title, dataScript, setExpr) => `<!doctype html><html><head><title>${title}</title></head><body>
<div id="passage"></div><div id="question"></div>
<div id="examFooter"><ul><li data-gtm-element-name="end" id="end"><span style="pointer-events:none"><u>E</u>nd</span></li></ul>
<ul><li data-gtm-element-name="previous" id="prev"><span style="pointer-events:none"><u>P</u>revious</span></li>
<li><span><span style="pointer-events:none">Na<u>v</u>igation</span></span></li>
<li data-gtm-element-name="next" id="next"><span style="pointer-events:none"><u>N</u>ext</span></li></ul></div>
${dataScript}
<script>
(function () {
  var qs = ${setExpr}, i = 0;
  document.getElementById('passage').innerHTML = qs[0].passage.passage;
  function show() {
    var q = qs[i];
    document.getElementById('question').innerHTML = '<div>Question ' + (i + 1) + '</div>' + q.question +
      q.options.map(function (o, k) { return '<label><input type="radio" name="' + o.key + '" value="' + o.key + '"> ' + 'ABCD'[k] + '.</label><div>' + o.value + '</div>'; }).join('');
    document.getElementById('next').style.visibility = i >= qs.length - 1 ? 'hidden' : 'visible';
  }
  document.getElementById('next').onclick = function () { if (i < qs.length - 1) { i++; show(); } };
  document.getElementById('prev').onclick = function () { if (i > 0) { i--; show(); } };
  document.getElementById('end').onclick = function () { fetch('/ended'); };
  show();
})();
</script></body></html>`;

// PHP escapes "/" in the page's script, as Jack Westin's does.
const jwJson = JSON.stringify(jwData).replace(/\//g, '\\/');
const jwHtml = examPage('AAMC Style Passages | Ritual Failures - Jack Westin', `<script>window.dailyData = ${jwJson};\nwindow.loggedIn = true;</script>`, 'window.dailyData.questions');
// Same screen, but the questions are kept out of reach: the extension has to step through.
const noDataHtml = examPage('AAMC Style Passages | Older One - Jack Westin', '', jwJson + '.questions');

const listHtml = `<!doctype html><html><head><title>CARS passages</title></head><body>
<aside><a href="${LIST}popular-old-one">Popular: an old passage</a></aside>
<main><h1>Daily CARS</h1>
<a href="${LIST}already-done">Yesterday (imported)</a>
<a href="${LIST}ritual-failures">Ritual Failures</a>
<a href="${LIST}older-one">Older passage</a>
<a href="${LIST}page/2">Next page</a></main></body></html>`;

// A generic site: questions from a data request, Next and Submit buttons.
const apiQuestions = [1, 2, 3].map((n) => ({ question: stem(n), answers: ['Alpha ' + n, 'Bravo ' + n, 'Charlie ' + n, 'Delta ' + n].map((text) => ({ text })) }));
const apiHtml = `<!doctype html><html><head><title>Api Passage</title></head><body>
<main><h1>Api Passage</h1><article id="passage"><p>${para(0)}</p><p>${para(3)}</p><p>${para(7)}</p></article>
<section id="q"></section><button id="next" type="button">Next</button><button id="submit" type="button">Submit</button></main>
<script>
let qs = [], i = 0;
const show = () => {
  const q = qs[i];
  document.getElementById('q').innerHTML = '<p>' + q.question + '</p>' + q.answers.map((a, k) => '<label><input type="radio" name="a"> ' + 'ABCD'[k] + '. ' + a.text + '</label><br>').join('');
  document.getElementById('next').disabled = i >= qs.length - 1;
};
document.getElementById('next').onclick = () => { if (i < qs.length - 1) { i++; show(); } };
document.getElementById('submit').onclick = () => fetch('/submitted');
fetch('/api/passages/api-passage').then((r) => r.json()).then((d) => { qs = d.data.questions; show(); });
</script></body></html>`;

let pressed = [];
let ctx;
try {
	ctx = await chromium.launchPersistentContext(profile, {
		channel: 'msedge',
		headless: true,
		args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
	});
} catch (err) {
	console.log(`Couldn't start Edge with the extension: ${err.message}`);
	process.exit(1);
}

async function captureFrom(page, url) {
	await page.goto(url);
	await page.waitForURL(MEDICUS + '/import/cars**', { timeout: 60000 });
	const hash = new URL(page.url()).hash.slice(1);
	if (!hash.startsWith('gz.')) return { hash };
	const b64 = hash.slice(3).replace(/-/g, '+').replace(/_/g, '/');
	return { hash, cap: JSON.parse(zlib.gunzipSync(Buffer.from(b64, 'base64')).toString('utf8')) };
}
const partsOf = (cap) => JSON.parse(cap.data ?? '{}').medicusParts ?? [];

try {
	await ctx.route('https://jackwestin.com/**', (route) => {
		const u = new URL(route.request().url());
		const p = u.pathname.replace(/\/+$/, '');
		if (p === '/ended' || p === '/submitted') {
			pressed.push(p);
			return route.fulfill({ status: 204, body: '' });
		}
		if (p === '/api/passages/api-passage') return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ data: { title: 'Api Passage', questions: apiQuestions } }) });
		if (p === '/daily/mcat-practice-passages/cars-practice-passages') return route.fulfill({ contentType: 'text/html', body: listHtml });
		if (p.endsWith('/ritual-failures')) return route.fulfill({ contentType: 'text/html', body: jwHtml });
		if (p.endsWith('/older-one')) return route.fulfill({ contentType: 'text/html', body: noDataHtml });
		if (p.endsWith('/api-passage')) return route.fulfill({ contentType: 'text/html', body: apiHtml });
		return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Wrong page</title><main>Wrong page</main>' });
	});
	await ctx.route(MEDICUS + '/**', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Medicus import</title><p>import</p>' }));
	const page = await ctx.newPage();
	const medicus = `#medicus=${encodeURIComponent(MEDICUS)}`;

	console.log('Jack Westin page (window.dailyData), from the list:');
	{
		const { hash, cap } = await captureFrom(page, `${LIST}${medicus}&skip=already-done`);
		check('ends on the Medicus import page with the capture', !!cap, hash.slice(0, 20));
		check('picked the newest passage not imported yet (from the list, not the sidebar)', /\/ritual-failures$/.test(cap?.url ?? ''), cap?.url);
		check('marked as sent by the extension', cap?.v === 3 && cap?.via === 'extension');
		const jw = partsOf(cap).find((p) => p.from === 'jw-daily');
		check('sent every question from the page’s data', jw?.value?.questions?.length === 3, JSON.stringify(partsOf(cap).map((p) => p.from)));
		check('with the answer key, explanations and passage', !!jw && jw.value.questions.every((q) => q.correct_answer && q.solution && q.options.length === 4 && /rituals persist/.test(q.passage?.passage ?? '')));
		const sent = JSON.stringify(jw ?? {});
		check('left out the account details and the answers picked on the site', !sent.includes('542177') && !sent.includes('secret-hash') && !sent.includes('selected_answer') && !sent.includes('previous_answer'));
		check('nothing needed clicking', (cap?.frames ?? []).length === 0, JSON.stringify(cap?.frames).slice(0, 120));
		check('the extension’s own button isn’t in the page text', !/Send to Medicus|Reading the passage/.test(cap?.text ?? ''));
		check('the page’s HTML (with its data) came too, for older Medicus versions', (cap?.html ?? '').includes('window.dailyData'));
	}

	console.log('Same screen without the data (steps through the <li> Next):');
	{
		const { cap } = await captureFrom(page, `${LIST}older-one${medicus}`);
		const stepped = (cap?.frames ?? []).join('\n');
		check('stepped to questions 2 and 3 with the list-item Next', /Question 2:/.test(stepped) && /Question 3:/.test(stepped), JSON.stringify(cap?.frames).slice(0, 200));
		check('stopped at the last question (Next hidden there)', (cap?.frames ?? []).length === 2, String((cap?.frames ?? []).length));
	}

	console.log('Generic page (questions from a data request, Next and Submit buttons):');
	{
		const { cap } = await captureFrom(page, `${LIST}api-passage${medicus}`);
		const stepped = (cap?.frames ?? []).join('\n');
		check('stepped through to the other questions', /Question 2:/.test(stepped) && /Question 3:/.test(stepped), JSON.stringify(cap?.frames).slice(0, 200));
		const fromNet = partsOf(cap).find((p) => p.from === 'response');
		check('kept the questions the page loaded', !!fromNet && fromNet.value.data.questions.length === 3, JSON.stringify(partsOf(cap).map((p) => p.from)));
	}

	check('never pressed End or Submit', pressed.length === 0, pressed.join(', '));
	await page.close();
} finally {
	await ctx.close();
	fs.rmSync(profile, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} extension check(s) failed.` : '\nExtension checks passed.');
process.exit(failures ? 1 : 0);
