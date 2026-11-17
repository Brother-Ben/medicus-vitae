// Browser test part 2 (same server, after part 1): password sign-in, card from a
// figure region, mistake repair cycle, progress logging, session planner, dark mode,
// snapshot, export, replay check, and the Quit button (stops the server).
//   node tests/e2e/browser-part2.mjs <baseUrl> <projectRoot> <screenshotDir>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [base, root, shots] = process.argv.slice(2);
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright-core');

let failures = 0;
let bookId = '';
const check = (label, cond, extra = '') => {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
	if (!cond) failures++;
};
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

for (let i = 0; i < 60; i++) {
	try {
		if ((await fetch(base + '/api/health')).ok) break;
	} catch {}
	await new Promise((r) => setTimeout(r, 250));
}

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

async function step(name, fn) {
	try {
		await fn();
	} catch (err) {
		failures++;
		console.log(`FAIL  ${name}: ${err && err.message ? err.message.split('\n')[0] : err}`);
		await shot(page, `zz-${name.replace(/\W+/g, '-')}`).catch(() => {});
	}
}

await step('sign in with the password', async () => {
	await page.goto(base + '/');
	check('signed-out visit goes to sign-in', page.url().includes('/login'), page.url());
	await page.fill('#password', 'wrong password');
	await page.click('button:has-text("Sign in")');
	await page.waitForSelector('text=That password isn’t right.');
	await page.fill('#password', 'correct horse battery');
	await page.click('button:has-text("Sign in")');
	await page.waitForSelector('text=What to work on');
	check('signed in with the password alone', (await page.locator('#code').count()) === 0);
});

await step('card from a figure region', async () => {
	await page.goto(base + '/library');
	await page.click('a:has-text("Resume"), a:has-text("Read")');
	await page.waitForSelector('.pdf-page[data-page="2"] canvas', { timeout: 30000 });
	const pg = page.locator('.pdf-page[data-page="2"]');
	await pg.scrollIntoViewIfNeeded();
	await page.click('button:has-text("Region")');
	const box = await pg.boundingBox();
	await page.evaluate(() => {
		const el = document.querySelector('.pdf-page[data-page="2"]');
		el.scrollIntoView({ block: 'end' });
	});
	const b = await pg.boundingBox();
	await page.mouse.move(b.x + b.width * 0.18, b.y + b.height * 0.66);
	await page.mouse.down();
	await page.mouse.move(b.x + b.width * 0.66, b.y + b.height * 0.9, { steps: 10 });
	await page.mouse.up();
	await page.waitForSelector('[aria-label="Selection actions"]');
	await shot(page, '12-region');
	await page.click('[aria-label="Selection actions"] button:has-text("Make card")');
	await page.fill('#card-front', 'What does this curve show?');
	await page.fill('#card-back', 'Rate approaches Vmax as [S] rises (saturation).');
	await page.click('dialog.modal[open] button:has-text("Create card")');
	await page.waitForSelector('text=Card created');
	check('region card created', box !== null);
	bookId = /\/library\/([^/]+)\/read/.exec(page.url())?.[1] ?? '';
});

await step('review shows the figure', async () => {
	// Only this book's cards (part 3 imported an Anki deck), answering any that come
	// before the new figure card (part 3 also approved AI-made cards from this book).
	await page.goto(base + '/review' + (bookId ? `?doc=${bookId}` : ''));
	for (let i = 0; i < 20; i++) {
		await page.waitForSelector('button:has-text("Show answer")', { timeout: 10000 });
		if (await page.locator('text=What does this curve show?').count()) break;
		await page.click('button:has-text("Show answer")');
		await page.click('button.rate-3');
		await page.waitForTimeout(400);
	}
	await page.waitForSelector('text=What does this curve show?', { timeout: 10000 });
	await page.waitForSelector('figure.region canvas:not(.hidden)', { timeout: 15000 });
	await page.click('button:has-text("Show answer")');
	await shot(page, '13-review-figure');
	await page.click('button.rate-3');
	check('figure card reviewed', true);
});

await step('mistake repair cycle', async () => {
	await page.goto(base + '/mistakes');
	await page.click('button:has-text("Log a mistake")');
	await page.click('label.reason:has-text("Content gap")');
	await page.selectOption('#m-cat', '1A');
	await page.fill('#m-summary', 'Noncompetitive inhibitor effect on Km');
	await page.fill('#m-todo', 'Sketch the Lineweaver-Burk plot');
	await page.click('dialog.modal[open] button:has-text("Log mistake")');
	await page.waitForURL('**/mistakes/**');
	await page.click('button:has-text("Start repair")');
	await page.waitForSelector('#explain');
	await page.check('text=I re-read the passage');
	await page.fill('#explain', 'It binds an allosteric site, so Vmax falls and Km stays the same.');
	await page.click('button:has-text("Finish repair")');
	await page.waitForSelector('text=Answer a different question');
	await page.click('button:has-text("Missed it again")');
	await page.waitForSelector('button:has-text("Start repair")');
	check('failed retest reopens it', (await page.locator('text=reopened 1×').count()) > 0);
	await page.click('button:has-text("Start repair")');
	await page.fill('#explain', 'Allosteric binding: extra substrate cannot displace it, so Vmax drops.');
	await page.click('button:has-text("Finish repair")');
	await page.fill('#retest-ref', 'UWorld 4512');
	await page.click('button:has-text("Got it right")');
	await page.waitForSelector('h2:has-text("Resolved")');
	await shot(page, '14-mistake-resolved');
	check('mistake resolved after retest', true);
});

await step('progress: full-length and practice', async () => {
	await page.goto(base + '/progress');
	await page.click('button:has-text("Scores only")');
	await page.fill('#fl-form-name', 'FL 1');
	await page.fill('#fl-cp', '127');
	await page.fill('#fl-cars', '126');
	await page.fill('#fl-bb', '129');
	await page.fill('#fl-ps', '129');
	await page.click('dialog.modal[open] button:has-text("Save")');
	await page.waitForSelector('svg.fl-chart circle', { timeout: 10000 });
	check('full-length plotted (total 511)', (await page.locator('svg.fl-chart text', { hasText: '511' }).count()) > 0);
	await page.click('button:has-text("Log practice")');
	await page.selectOption('#pr-cat', '4B');
	await page.fill('#pr-total', '12');
	await page.fill('#pr-correct', '9');
	await page.click('dialog.modal[open] button:has-text("Save")');
	await page.waitForSelector('td:has-text("9/12")', { timeout: 10000 });
	await page.click('button[role=tab]:has-text("Practice")');
	const tile = await page.locator('a.tile', { hasText: '4B' }).innerText();
	check('heatmap practice tile shows 75%', tile.includes('75%'), tile.replace(/\s+/g, ' '));
	await page.locator('#heatmap').scrollIntoViewIfNeeded();
	await shot(page, '15-progress');
});

await step('AAMC full-length import (typed wrong numbers)', async () => {
	await page.goto(base + '/progress');
	await page.click('button:has-text("Import from AAMC")');
	await page.waitForSelector('dialog.modal[open] >> text=Import a full-length');
	await page.click('dialog.modal[open] button[role=tab]:has-text("Type the ones I got wrong")');
	// The first box is Chem/Phys "wrong"; sections left blank aren't recorded.
	await page.locator('dialog.modal[open] .wrong-grid input').first().fill('3, 7, 12-14');
	await page.locator('dialog.modal[open] .scores label:has-text("Total") input').fill('510');
	await page.click('dialog.modal[open] button:has-text("Save")');
	await page.waitForURL('**/progress/full-lengths/**', { timeout: 15000 });
	await page.waitForSelector('#grid-h');
	check('every Chem/Phys question on the grid', (await page.locator('.q-grid .q').count()) === 59, String(await page.locator('.q-grid .q').count()));
	check('the typed ones marked wrong', (await page.locator('.q-grid .q.bad').count()) === 5);
	await shot(page, '15b-full-length-review');
});

await step('time-budget session', async () => {
	await page.goto(base + '/');
	await page.click('button:has-text("Plan a session")');
	await page.click('dialog.modal[open] button:has-text("30 min")');
	await page.waitForSelector('ul.plan li', { timeout: 10000 });
	await page.click('ul.plan li >> button:has-text("Why this?")');
	await shot(page, '16-session-plan');
	await page.click('dialog.modal[open] button:has-text("Start session")');
	// Straight to the first item, with the session bar on top.
	await page.waitForURL(/\/(review|library|mistakes)/, { timeout: 15000 });
	await page.waitForSelector('aside.dock', { timeout: 15000 });
	check('session starts on its first item', /\/(review|library|mistakes)/.test(page.url()), page.url());
	await page.click('aside.dock a[aria-label="Open the session plan"]');
	await page.waitForURL('**/session/**');
	check('session plan opens', (await page.locator('ul.items li').count()) > 0);
	await shot(page, '17-session');
	await page.click('button:has-text("End session")');
});

await step('themes', async () => {
	// Default theme: Clinic Dark.
	await page.goto(base + '/');
	await page.waitForSelector('text=What to work on');
	check('Clinic Dark by default', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'clinic-dark');
	const bgDark = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	check('Clinic Dark background', bgDark === 'rgb(14, 20, 19)', bgDark);
	await page.goto(base + '/settings/appearance');
	await page.click('button.theme-card:has-text("Paper")');
	await page.waitForTimeout(800);
	await page.goto(base + '/');
	await page.waitForSelector('text=What to work on');
	const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
	check('Paper theme kept after reload (saved to the account)', bg === 'rgb(242, 236, 225)', bg);
	await shot(page, '18-today-paper');
	await page.goto(base + '/settings/appearance');
	await page.click('button.theme-card:has-text("Clinic Dark")');
	await page.waitForTimeout(800);
});

await step('snapshot, export, replay check', async () => {
	await page.goto(base + '/settings/sync');
	await page.click('button:has-text("Take a snapshot now")');
	await page.waitForSelector('td:has-text("Manual")', { timeout: 15000 });
	check('manual snapshot listed', true);
	await shot(page, '19-sync');
	await page.goto(base + '/settings/data');
	const [download] = await Promise.all([page.waitForEvent('download'), page.click('a:has-text("Export everything")')]);
	const file = path.join(shots, 'export.zip');
	await download.saveAs(file);
	check('export downloaded', fs.statSync(file).size > 20000, `${fs.statSync(file).size} bytes`);
	await page.click('button:has-text("Run check")');
	await page.waitForSelector('text=cards match their', { timeout: 10000 });
	check('replay check passes', true, await page.locator('.notice').last().innerText());
});

await step('quit from the web page', async () => {
	await page.goto(base + '/');
	await page.click('button[aria-label="Quit Medicus"]');
	await page.waitForSelector('dialog.modal[open] >> text=Quit Medicus?');
	await shot(page, '20-quit-confirm');
	await page.click('dialog.modal[open] button:has-text("Quit")');
	await page.waitForSelector('text=Medicus Vitae has stopped');
	await shot(page, '21-stopped');
	let down = false;
	for (let i = 0; i < 20 && !down; i++) {
		await new Promise((r) => setTimeout(r, 500));
		try {
			await fetch(base + '/api/health');
		} catch {
			down = true;
		}
	}
	check('server process stopped', down);
});

// 400s come from the deliberately wrong password and code at sign-in.
const relevant = errors.filter((e) => !/favicon|status of 400|status of 409|net::ERR_CONNECTION_REFUSED|Failed to fetch/.test(e));
check('no browser errors', relevant.length === 0, relevant.slice(0, 5).join(' | '));
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
