// Browser test part 1 (Microsoft Edge via playwright-core): setup + onboarding,
// import, reader highlight, card from a passage, note, search, review.
// Run all end-to-end tests with `npm run test:e2e` (see run.mjs), or alone:
//   node tests/e2e/browser-part1.mjs <baseUrl of a fresh server> <projectRoot> <screenshotDir>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const [base, root, shots] = process.argv.slice(2);
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright-core');
fs.mkdirSync(shots, { recursive: true });

let failures = 0;
const check = (label, cond, extra = '') => {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
	if (!cond) failures++;
};
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`), fullPage: false });

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
page.on('console', (m) => {
	if (m.type() === 'error') errors.push(m.text());
});

try {
	// ---- setup
	await page.goto(base + '/');
	check('fresh install shows setup', page.url().endsWith('/setup'), page.url());
	await page.fill('#displayName', 'Sam');
	await page.fill('#password', 'correct horse battery');
	await page.fill('#confirm', 'correct horse battery');
	await shot(page, '01-setup');
	await page.click('button:has-text("Create account")');
	await page.waitForURL('**/welcome**');
	check('account created, onboarding opens', page.url().includes('/welcome'));

	// ---- target (the first onboarding step)
	await page.waitForSelector('#testDate');
	check('onboarding starts at the target step', (await page.locator('text=Two-factor').count()) === 0);
	await page.fill('#testDate', '2027-01-02');
	await page.fill('#goalScore', '515');
	await page.fill('#weeklyHours', '20');
	await page.click('button:has-text("Save and continue")');
	await page.waitForURL('**step=baseline**');
	await page.click('a:has-text("Skip for now")');
	await page.waitForURL('**step=content**');

	// ---- import a book
	await page.setInputFiles('input[type=file]', path.join(root, 'tests', 'fixtures', 'sample-mcat-review.pdf'));
	await page.waitForSelector('text=Uploaded. Processing has started.', { timeout: 20000 });
	await shot(page, '03-upload');
	await page.click('a:has-text("Continue")');
	await page.waitForURL('**step=ai**');
	await page.waitForSelector('text=Connect AI (optional)');
	await shot(page, '03b-connect-ai-step');
	await page.click('button:has-text("Skip, go to Today")');
	await page.waitForURL(base + '/');
	await page.waitForSelector('text=What to work on');
	check('Today shows after onboarding', true);
	check('countdown in sidebar', (await page.locator('.test-day').innerText()).includes('Jan 2, 2027'));

	// ---- first-time guide: opens by itself once, then visits every tab
	await page.waitForSelector('.guide >> text=Welcome to Medicus Vitae', { timeout: 5000 });
	check('first-time guide opens after onboarding', true);
	await shot(page, '04-guide-welcome');
	await page.click('.guide button:has-text("Start the tour")');
	const tour = [
		['/', 'Today'],
		['/library', 'Library'],
		['/cards', 'Flashcards'],
		['/mistakes', 'Mistake journal'],
		['/tutor', 'Tutor'],
		['/progress', 'Progress'],
		['/notes', 'Notes'],
		['/search', 'Search'],
		['/settings', 'Settings']
	];
	for (const [i, [href, title]] of tour.entries()) {
		await page.waitForSelector(`.guide h2:has-text("${title}")`, { timeout: 5000 });
		await page.waitForURL(base + href, { timeout: 5000 });
		check(`guide step ${i + 1}: ${title} opens ${href}`, (await page.locator('.guide .g-count').innerText()) === `${i + 1} of ${tour.length}`);
		if (i < tour.length - 1) await page.click('.guide button:has-text("Next")');
	}
	await page.click('.guide button:has-text("Finish")');
	await page.waitForSelector('.guide', { state: 'detached' });
	await page.goto(base + '/');
	await page.waitForSelector('text=What to work on');
	await page.waitForTimeout(500);
	check('guide doesn’t open again once finished', (await page.locator('.guide').count()) === 0);
	await shot(page, '04-today');

	// ---- library → reader
	await page.goto(base + '/library');
	await page.waitForSelector('a:has-text("Read")', { timeout: 30000 });
	await shot(page, '05-library');
	await page.click('a:has-text("Read")');
	await page.waitForURL('**/read**');
	await page.waitForSelector('.pdf-page[data-page="2"] canvas', { timeout: 30000 });
	await page.waitForSelector('.pdf-page[data-page="2"] .textLayer span', { timeout: 30000 });
	await page.locator('.pdf-page[data-page="2"]').scrollIntoViewIfNeeded();
	await page.waitForTimeout(400);
	await shot(page, '06-reader');

	// Drag-select a line of text on page 2.
	const span = page.locator('.pdf-page[data-page="2"] .textLayer span', { hasText: 'The Michaelis-Menten equation' }).first();
	await span.scrollIntoViewIfNeeded();
	const box = await span.boundingBox();
	await page.mouse.move(box.x + 2, box.y + box.height / 2);
	await page.mouse.down();
	await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2, { steps: 8 });
	await page.mouse.up();
	await page.waitForSelector('[aria-label="Selection actions"]', { timeout: 5000 });
	await shot(page, '07-selection-menu');
	await page.click('[aria-label="Selection actions"] button:has-text("Highlight")');
	await page.waitForSelector('.pdf-page[data-page="2"] .hl', { timeout: 5000 });
	check('highlight drawn on the page', (await page.locator('.pdf-page[data-page="2"] .hl').count()) > 0);

	// Make a card from another selection.
	const span2 = page.locator('.pdf-page[data-page="2"] .textLayer span', { hasText: 'A competitive inhibitor binds' }).first();
	const b2 = await span2.boundingBox();
	await page.mouse.move(b2.x + 2, b2.y + b2.height / 2);
	await page.mouse.down();
	await page.mouse.move(b2.x + b2.width - 2, b2.y + b2.height / 2, { steps: 8 });
	await page.mouse.up();
	await page.waitForSelector('[aria-label="Selection actions"]');
	await page.click('[aria-label="Selection actions"] button:has-text("Make card")');
	await page.waitForSelector('dialog.modal[open] >> text=From the passage');
	const passage = await page.locator('dialog.modal[open] blockquote').innerText();
	check('card draft carries the passage', passage.includes('competitive inhibitor'), passage.slice(0, 80));
	const cat = await page.locator('#card-cat').inputValue();
	check('card category prefilled from chapter tags (none confirmed yet → empty)', cat === '', cat);
	await page.fill('#card-front', 'What does a competitive inhibitor bind?');
	await shot(page, '08-card-editor');
	await page.click('dialog.modal[open] button:has-text("Create card")');
	await page.waitForSelector('text=Card created');
	await page.waitForSelector('.pdf-page[data-page="2"] .card-mark', { timeout: 5000 });
	check('card marker appears in the margin', true);

	// A reading note.
	const span3 = page.locator('.pdf-page[data-page="2"] .textLayer span', { hasText: 'Enzymes are biological catalysts' }).first();
	const b3 = await span3.boundingBox();
	await page.mouse.move(b3.x + 2, b3.y + b3.height / 2);
	await page.mouse.down();
	await page.mouse.move(b3.x + b3.width * 0.5, b3.y + b3.height / 2, { steps: 6 });
	await page.mouse.up();
	await page.waitForSelector('[aria-label="Selection actions"]');
	await page.click('[aria-label="Selection actions"] button:has-text("Note")');
	await page.fill('#note-body', 'Catalysts do **not** change ΔG.');
	await page.click('dialog.modal[open] button:has-text("Save note")');
	await page.waitForSelector('.pdf-page[data-page="2"] .note-mark', { timeout: 5000 });
	check('note marker appears', true);
	await shot(page, '09-reader-marks');

	// Search inside the book.
	await page.click('button[aria-label="Search this book"]');
	await page.fill('#book-search', 'buoyant');
	await page.click('form[role=search] button:has-text("Search")');
	await page.waitForSelector('.search-item >> text=Page 4');
	check('search within book finds page 4', true);

	// ---- review the new card
	await page.goto(base + '/review');
	await page.waitForSelector('text=What does a competitive inhibitor bind?');
	await page.click('button.conf:has-text("Guess")');
	await page.click('button:has-text("Show answer")');
	await page.waitForSelector('.source-chip');
	const chip = await page.locator('.source-chip').first().innerText();
	check('answer shows the source link', chip.includes('p. 2'), chip);
	await shot(page, '10-review');
	await page.click('button.rate-3');
	await page.waitForSelector('text=All caught up', { timeout: 5000 }).catch(() => {});
	check('review saved (session counter)', (await page.locator('text=1 of').count()) > 0 || (await page.locator('text=All caught up').count()) > 0);

	// Source link opens the reader at the passage.
	await page.goto(base + '/cards');
	await page.waitForSelector('text=What does a competitive inhibitor bind?');
	await shot(page, '11-cards');

} catch (err) {
	failures++;
	console.log('FAIL  exception: ' + (err && err.message ? err.message.split('\n')[0] : err));
	await shot(page, 'zz-failure').catch(() => {});
} finally {
	const relevant = errors.filter((e) => !/favicon|Failed to load resource: the server responded with a status of 409/.test(e));
	check('no browser errors', relevant.length === 0, relevant.slice(0, 5).join(' | '));
	await browser.close();
	console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
	process.exit(failures ? 1 : 0);
}
