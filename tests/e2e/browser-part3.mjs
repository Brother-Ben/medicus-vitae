// Browser test part 3 (same server, after part 1; the server runs with
// CORTEX_FAKE_AI=1 so the tutor works without an account): Anki import with its
// report, an imported card in review (deck styling, math, media), leeches, the
// tutor with citations that open the book, generation + approval, the quiz,
// Meaning search and Settings › AI.
//   node tests/e2e/browser-part3.mjs <baseUrl> <projectRoot> <screenshotDir>
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const [base, root, shots] = process.argv.slice(2);
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('playwright-core');
const { makeAnkiPackage } = await import(pathToFileURL(path.join(root, 'tests', 'fixtures', 'make-anki-packages.mjs')).href);

let failures = 0;
const check = (label, cond, extra = '') => {
	console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
	if (!cond) failures++;
};
const shot = (page, name) => page.screenshot({ path: path.join(shots, `${name}.png`) });

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
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
		await shot(page, `zz3-${name.replace(/\W+/g, '-')}`).catch(() => {});
	}
}

await step('sign in', async () => {
	await page.goto(base + '/login');
	await page.fill('#password', 'correct horse battery');
	await page.click('button:has-text("Sign in")');
	await page.waitForSelector('text=What to work on');
	check('signed in', true);
	check('tutor in the sidebar (AI connected)', (await page.locator('nav >> a:has-text("Tutor")').count()) > 0);
	// Today stays short by default; the tutor box is one switch away.
	check('Today leaves the tutor box out by default', (await page.locator('#tutor-h').count()) === 0);
	await page.click('button[aria-label="Choose what Today shows"]');
	await page.locator('dialog.modal[open] input[aria-label="Show Ask the tutor"]').check();
	await page.click('dialog.modal[open] button:has-text("Done")');
	await page.waitForSelector('#tutor-h', { timeout: 5000 });
	check('Ask the tutor on Today once turned on', (await page.locator('text=Ask the tutor').count()) > 0);
});

await step('Anki import with report', async () => {
	const apkg = path.join(shots, 'mcat-deck.apkg');
	await makeAnkiPackage(apkg, { format: 'latest', variant: 'v1' });
	await page.goto(base + '/cards/import');
	await page.setInputFiles('input[type=file]', apkg);
	await page.waitForURL('**/cards/import/**');
	await page.waitForSelector('text=What will happen', { timeout: 30000 });
	const report = await page.locator('main, .page').first().innerText();
	check('card scripts aren’t reported as unsupported', !report.includes('Card scripts run in a sealed frame'));
	check('report shows the deck’s tags coming in', /notes come with their tags/.test(report), report.replace(/\s+/g, ' ').slice(0, 200));
	check('report says image occlusion masks can’t be edited', report.includes('Image occlusion masks can’t be edited here'));
	check('report describes review history', /past reviews for/.test(report));
	await shot(page, '30-anki-report');
	await page.locator('button.btn-primary', { hasText: /^Import \d/ }).click();
	await page.waitForSelector('h2:has-text("Imported")', { timeout: 60000 });
	const done = await page.locator('section.card').first().innerText();
	check('notes and cards imported', /New notes\s*11/.test(done) && /New cards\s*15/.test(done), done.replace(/\s+/g, ' ').slice(0, 160));
	await shot(page, '31-anki-imported');
});

await step('imported card in review: deck styling, math, media', async () => {
	const media = await page.request.get(base + '/api/media/cell.png');
	check('media served', media.status() === 200 && (media.headers()['content-type'] ?? '').startsWith('image/png'));
	await page.goto(base + '/review?deck=' + encodeURIComponent('MCAT::Chem-Phys'));
	await page.waitForSelector('iframe.anki-card', { timeout: 15000 });
	check('the card frame is sealed off (scripts, but no same-origin access)', (await page.locator('iframe.anki-card').getAttribute('sandbox')) === 'allow-scripts allow-popups allow-popups-to-escape-sandbox');
	const frame = page.frameLocator('iframe.anki-card');
	await frame.locator('text=Henderson').waitFor({ timeout: 10000 });
	check('Anki card front rendered in its frame', true);
	check('studying one deck counts only that deck', (await page.locator('.pill', { hasText: 'New' }).first().innerText()).trim() === 'New 1');
	await page.click('button:has-text("Show answer")');
	await frame.locator('.katex').first().waitFor({ timeout: 10000 });
	check('math typeset on the answer', true);
	check('Explain with tutor offered', (await page.locator('a:has-text("Explain with tutor")').count()) > 0);
	await shot(page, '32-anki-review');
	// Rating keeps to the deck: the next card (here the same one, back for its next learning step) is from Chem-Phys too.
	await page.click('button.rate-3');
	await page.waitForTimeout(1000);
	const deckTag = await page.locator('.topic-tag', { hasText: 'Chem-Phys' }).count();
	check('next card stays in the chosen deck', deckTag > 0 || (await page.locator('text=in this filter').count()) > 0);
	const frameMedia = await page.request.get(base + '/api/media/k/not-a-real-key/cell.png');
	check('frame media needs the daily key', frameMedia.status() === 404);
});

await step('leech flagged, not suspended', async () => {
	await page.goto(base + '/cards?state=leech');
	await page.waitForSelector('text=Methionine', { state: 'attached', timeout: 5000 }).catch(() => {});
	const rows = await page.locator('.list-row').allInnerTexts();
	check('one leech listed', rows.length === 1 && rows[0].includes('Leech') && !rows[0].includes('Suspended'), rows.join(' | ').slice(0, 200));
});

await step('tutor answers with a citation that opens the book', async () => {
	await page.goto(base + '/tutor');
	await page.fill('#tutor-input-f', 'What does a noncompetitive inhibitor do to Km?');
	await page.click('button[aria-label="Ask"]');
	await page.waitForSelector('.msg.assistant .answer a.cite', { timeout: 30000 });
	await shot(page, '33-tutor-answer');
	check('answer has a numbered source', (await page.locator('.sources li').count()) >= 1);
	await page.click('.msg.assistant .answer a.cite');
	await page.waitForURL('**/read?anchor=**', { timeout: 15000 });
	check('citation opens the reader at the passage', page.url().includes('/read?anchor='));
	await page.waitForSelector('.pdf-page canvas', { timeout: 30000 });
	await shot(page, '34-citation-in-reader');
});

await step('not in your material', async () => {
	await page.goto(base + '/tutor');
	await page.fill('#tutor-input-f', 'Who painted the Mona Lisa?');
	await page.click('button[aria-label="Ask"]');
	await page.waitForSelector('text=Not in your material', { timeout: 30000 });
	check('says the answer is not in the material', true);
});

async function generate(kind) {
	await page.goto(base + '/library');
	await page.click('.page a[href^="/library/"]:not([href*="/read"])');
	await page.waitForSelector('button[aria-label^="Generate from"]', { timeout: 15000 });
	await page.locator('button[aria-label^="Generate from"]').first().click();
	await page.waitForSelector('dialog.modal[open]');
	if (kind === 'question') await page.click('dialog.modal[open] button[role=radio]:has-text("Quiz questions")');
	await page.click('dialog.modal[open] button.btn-navy:has-text("Generate")');
	await page.waitForSelector('dialog.modal[open] >> text=ready for review', { timeout: 60000 });
	await page.click('dialog.modal[open] a:has-text("Review them")');
	await page.waitForURL('**/tutor/queue');
}

await step('generate cards and approve them', async () => {
	await generate('card');
	await shot(page, '35-approvals');
	await page.click('button:has-text("Approve all")');
	await page.waitForSelector('text=Nothing waiting', { timeout: 10000 });
	await page.goto(base + '/cards?q=' + encodeURIComponent('Test question'));
	check('AI-made cards in the card list', (await page.locator('.list-row').count()) >= 1);
});

await step('quiz from an approved question', async () => {
	await generate('question');
	await page.click('button:has-text("Approve")');
	await page.waitForSelector('text=Nothing waiting', { timeout: 10000 });
	await page.goto(base + '/quiz');
	await page.waitForSelector('.choice', { timeout: 10000 });
	await page.locator('.choice').first().click();
	await page.waitForSelector('text=Right.', { timeout: 10000 });
	await shot(page, '36-quiz');
	check('quiz answer recorded', true);
});

await step('meaning search and AI settings', async () => {
	await page.goto(base + '/search?q=enzyme%20saturation&mode=meaning');
	await page.waitForSelector('a[aria-current="page"]:has-text("Meaning")');
	check('meaning search falls back to keywords without the model', (await page.locator('text=meaning index isn’t ready yet').count()) === 1);
	check('meaning search shows results', (await page.locator('.list-row').count()) > 0);
	await page.goto(base + '/settings/ai');
	await page.waitForSelector('text=What each feature sends');
	check('AI settings show data flow and index', (await page.locator('text=Search index').count()) > 0);
	await shot(page, '37-settings-ai');
});

// ---------------------------------------------------------------- 0.6 features

await step('set due date for a deck', async () => {
	await page.goto(base + '/cards');
	await page.waitForSelector('#decks-h');
	await page.locator('button[aria-label^="More for"]').first().click();
	// The ⋯ menu sits above the deck list (which clips what sticks out of it), fully on screen.
	const menu = page.locator('[role=menu]');
	await menu.waitFor();
	const box = await menu.boundingBox();
	const vp = page.viewportSize();
	const onBody = await menu.evaluate((el) => el.parentElement === document.body);
	check('the ⋯ menu is shown in full', !!box && !!vp && onBody && box.y >= 0 && box.x >= 0 && box.y + box.height <= vp.height && box.x + box.width <= vp.width, JSON.stringify(box));
	const reachable = await menu.evaluate((el) =>
		[...el.querySelectorAll('[role=menuitem]')].every((item) => {
			const r = item.getBoundingClientRect();
			const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
			return !!hit && item.contains(hit);
		})
	);
	check('every item in the ⋯ menu can be clicked', reachable);
	await shot(page, '39-deck-menu');
	await page.click('[role=menu] button:has-text("Set due date")');
	await page.waitForSelector('dialog.modal[open] >> text=Only the date moves');
	await page.click('dialog.modal[open] button[role=radio]:has-text("Every card, new too")');
	await page.click('dialog.modal[open] button[role=radio]:has-text("In a week")');
	await shot(page, '40-due-date');
	await page.click('dialog.modal[open] button:has-text("Set due date")');
	await page.waitForSelector('text=/Due date set for \\d+ card/', { timeout: 10000 });
	check('due date set for a deck', true);
	await page.goto(base + '/settings/data');
	// Every settings section is in the side menu and on screen.
	const sections = await page.locator('nav.settings-nav a').evaluateAll((els) =>
		els.map((a) => {
			const r = a.getBoundingClientRect();
			return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth;
		})
	);
	check('all settings sections reachable in the side menu', sections.length === 9 && sections.every(Boolean), JSON.stringify(sections));
	await page.click('button:has-text("Run check")');
	await page.waitForSelector('text=cards match their', { timeout: 15000 });
	check('replay check still passes after due-date changes', true);
});

await step('focus session with a break', async () => {
	await page.goto(base + '/');
	await page.click('button:has-text("Plan a session")');
	const plan = 'dialog.modal[open]';
	await page.waitForSelector(`${plan} button:has-text("Your own task")`);
	await page.locator(`${plan} button:has-text("25 min")`).click();
	await page.click(`${plan} button:has-text("Your own task")`);
	await page.fill('#task-title', 'CARS passage');
	await page.click(`${plan} button:has-text("Add to plan")`);
	await page.waitForSelector('ul.plan li >> text=CARS passage');
	await shot(page, '41-plan');
	await page.click(`${plan} button:has-text("Start session")`);
	await page.waitForURL(/\/(review|library|mistakes)/, { timeout: 15000 });
	await page.waitForSelector('aside.dock', { timeout: 15000 });
	check('session bar shows on the first item', /\/(review|library|mistakes)/.test(page.url()), page.url());
	check('focus timer running', (await page.locator('aside.dock .phase').innerText()).toLowerCase().includes('focus'));
	await shot(page, '42-session-bar');
	const firstItem = new URL(page.url()).searchParams.get('item');
	await page.click('aside.dock button:has-text("Done, next")');
	await page.waitForURL((u) => new URL(u).searchParams.get('item') !== firstItem, { timeout: 15000 });
	check('“Done, next” goes to the next item', true, new URL(page.url()).pathname);
	await page.click('aside.dock a[aria-label="Open the session plan"]');
	await page.waitForSelector('text=Take the break now');
	await page.click('button:has-text("Take the break now")');
	await page.waitForSelector('.break-screen', { timeout: 10000 });
	check('break screen with a breathing guide', (await page.locator('.break-screen .breath').count()) === 1);
	await page.click('.break-screen button[role=tab]:has-text("Relax")');
	check('calm reminder shown', (await page.locator('.break-screen .prompt').innerText()).length > 5);
	await shot(page, '43-break');
	await page.click('.break-screen button:has-text("end the break")');
	await page.waitForSelector('.break-screen >> text=Ready for round 2', { timeout: 10000 });
	await page.click('.break-screen button:has-text("Start focusing")');
	await page.waitForSelector('.break-screen', { state: 'detached', timeout: 10000 });
	check('next round started', (await page.locator('.timer-card .phase').innerText()).toLowerCase().includes('round 2'));
	await page.click('button:has-text("End session")');
	await page.waitForSelector('aside.dock', { state: 'detached', timeout: 10000 }).catch(() => {});
});

await step('AI coach on Today', async () => {
	// Off by default; turned on in Settings › Menu & Today.
	await page.goto(base + '/settings/layout');
	await page.locator('input[aria-label="Show AI coach"]').check();
	await page.waitForTimeout(800);
	await page.goto(base + '/');
	await page.waitForSelector('#coach-h');
	await page.click('button:has-text("Suggest what to do")');
	await page.waitForSelector('.coach >> text=Review due cards', { timeout: 20000 });
	check('coach suggests what to work on', (await page.locator('.coach button:has-text("Make this my session")').count()) === 1);
	await page.click('.coach button[role=tab]:has-text("Weekly recap")');
	await page.click('button:has-text("Write my recap")');
	await page.waitForSelector('.coach >> text=A steady week', { timeout: 20000 });
	check('weekly recap written', true);
	await shot(page, '44-coach');
});

await step('notes PDF linked to book pages', async () => {
	// A different file than the book (same bytes would just find the book again).
	const pdf = fs.readFileSync(path.join(root, 'tests', 'fixtures', 'sample-mcat-review.pdf'));
	const notesPdf = path.join(shots, 'my-enzyme-notes.pdf');
	fs.writeFileSync(notesPdf, Buffer.concat([pdf, Buffer.from('\n% my notes\n')]));
	await page.goto(base + '/notes');
	await page.click('button:has-text("Upload notes PDF")');
	await page.setInputFiles('input[type=file]', notesPdf);
	await page.waitForSelector('text=Uploaded. Processing has started.', { timeout: 20000 });
	await page.waitForSelector('.pdf-card button:has-text("Link to book pages")', { timeout: 20000 });
	await page.click('.pdf-card button:has-text("Link to book pages")');
	await page.waitForSelector('dialog.modal[open] >> text=Book pages');
	await page.fill('#b-from', '2');
	await page.fill('#b-to', '3');
	await page.fill('#l-label', 'Enzyme summary');
	await page.click('dialog.modal[open] button:has-text("Link")');
	await page.waitForSelector('.pdf-card >> text=pp. 2–3', { timeout: 10000 });
	check('notes PDF linked', true);
	await page.click('button[role=tab]:has-text("PDFs")');
	check('PDF filter shows it', (await page.locator('.pdf-card').count()) === 1 && (await page.locator('.note-card:not(.pdf-card)').count()) === 0);
	await shot(page, '45-notes');
	await page.click('.pdf-card a.source-chip');
	await page.waitForURL('**/read?page=2', { timeout: 15000 });
	await page.waitForSelector('.linked-bar >> text=Enzyme summary', { timeout: 15000 });
	check('reader shows your notes for that page', true);
	await page.goto(base + '/library');
	check('notes PDF is not in the Library', (await page.locator('text=my-enzyme-notes').count()) === 0);
});

await step('season themes and decorations', async () => {
	await page.goto(base + '/settings/appearance');
	await page.click('button[role=radio]:has-text("Follow the seasons")');
	await page.click('button[role=radio]:has-text("Always day")');
	await page.waitForTimeout(300);
	const month = new Date().getMonth();
	const season = month >= 8 && month <= 10 ? 'fall' : month === 11 || month <= 1 ? 'winter' : month <= 4 ? 'spring' : 'summer';
	check('follows the season', (await page.evaluate(() => document.documentElement.dataset.theme)) === season);
	await page.click('button[role=radio]:has-text("Pick one")');
	await page.click('button.theme-card:has-text("Spring Night")');
	await page.waitForTimeout(300);
	check('season theme picked any time', (await page.evaluate(() => document.documentElement.dataset.theme)) === 'spring-night');
	await page.click('button[role=radio]:has-text("Seasons only")');
	await page.click('[aria-labelledby="dseason-l"] button:has-text("Summer")');
	await page.waitForTimeout(400);
	check('summer decorations whatever the date', (await page.locator('.decor-overlay .particle.firefly').count()) > 0);
	await shot(page, '46-spring-night-summer');
	await page.locator('input[aria-label="Test-day countdown in the menu"]').click();
	check('test day can be hidden', (await page.locator('.test-day').count()) === 0);
	await page.locator('input[aria-label="Test-day countdown in the menu"]').click();
	await page.locator('input[aria-label="Fold the sidebar to icons"]').click();
	check('sidebar folds to icons', (await page.evaluate(() => document.documentElement.dataset.sidebar)) === 'collapsed');
	// The shortcut is ignored while typing in a field, so leave the switch first.
	await page.evaluate(() => document.activeElement && document.activeElement.blur());
	await page.keyboard.press('[');
	check('[ opens it again', (await page.evaluate(() => document.documentElement.dataset.sidebar)) === undefined);
	// Back to the defaults the later tests expect.
	await page.click('[aria-labelledby="dseason-l"] button:has-text("Match theme")');
	await page.click('button[role=radio]:has-text("Seasons and holidays")');
	await page.click('button.theme-card:has-text("Clinic Dark")');
	await page.waitForTimeout(800);
});

await step('Anki sync page', async () => {
	await page.goto(base + '/settings/anki');
	await page.waitForSelector('text=Set it up (once)');
	check('setup guide shows the AnkiConnect code', (await page.locator('code:has-text("2055492159")').count()) === 1);
	await page.waitForSelector('[role=status]', { timeout: 15000 });
	await shot(page, '47-anki-sync');
});

await step('CARS daily passage switch', async () => {
	await page.goto(base + '/cards/cars');
	const sw = page.locator('.prefs input.switch');
	await sw.waitFor();
	// A pill-shaped switch, not squeezed into a dot by the checkbox label around it.
	const box = await sw.boundingBox();
	check('daily switch has its full shape', !!box && box.width >= 30 && box.width > box.height * 1.5, JSON.stringify(box));
	const knobInside = await sw.evaluate((el) => {
		const s = getComputedStyle(el, '::after');
		const shift = new DOMMatrix(s.transform === 'none' ? undefined : s.transform).m41;
		return parseFloat(s.left) + shift + parseFloat(s.width) <= el.getBoundingClientRect().width + 0.5;
	});
	check('the switch’s knob stays inside it', knobInside);
	const was = await sw.isChecked();
	await sw.click();
	await page.waitForFunction((v) => document.querySelector('.prefs input.switch')?.checked === v, !was);
	await page.waitForTimeout(500);
	await page.reload();
	await sw.waitFor();
	check('switching daily passages saves', (await sw.isChecked()) === !was);
	check('“per day” follows the switch', (await page.locator('.prefs select').first().isDisabled()) === was);
	await shot(page, '49-cars-daily');
	await sw.click();
	await page.waitForFunction((v) => document.querySelector('.prefs input.switch')?.checked === v, was);
	await page.waitForTimeout(500);
});

await step('reset with undo', async () => {
	await page.goto(base + '/settings/data');
	await page.locator('label.reset-item:has-text("Tutor") input').check();
	await page.click('button:has-text("Reset 1 part")');
	await page.waitForSelector('dialog.modal[open] >> text=Are you sure?');
	check('reset waits for RESET to be typed', await page.locator('dialog.modal[open] button:has-text("Yes, reset")').isDisabled());
	await shot(page, '48-reset-confirm');
	await page.fill('#confirm-reset', 'reset');
	await page.click('dialog.modal[open] button:has-text("Yes, reset")');
	await page.waitForSelector('text=Reset done', { timeout: 20000 });
	await page.click('button:has-text("Undo reset")');
	await page.waitForURL(base + '/', { timeout: 30000 });
	await page.waitForSelector('text=What to work on', { timeout: 20000 });
	check('undo brings the data back', true);
});

const relevant = errors.filter((e) => !/favicon|status of 404|status of 409/.test(e));
check('no browser errors', relevant.length === 0, relevant.slice(0, 5).join(' | '));
await browser.close();
console.log(failures ? `\n${failures} FAILED` : '\nALL PASSED');
process.exit(failures ? 1 : 0);
