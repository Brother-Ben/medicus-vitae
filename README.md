# Medicus Vitae

*Medicus Vitae* ("doctor of life"; **Medicus** for short) is a personal MCAT study app: read your books, turn passages into flashcards, review them with FSRS, track the questions you miss and fix them, log full-lengths, and see where you're weak by AAMC category. It runs on your own computer and opens in your browser. One person per installation; your phone can reach it over Tailscale. (It was called Cortex before version 0.5.)

This version covers the core study loop and backups, Anki import, and the grounded AI tutor, plus themes and seasonal decorations. Offline phone reviews, change-by-change sync and OCR come later.

## Download and install

Get the newest version from the **[Releases page](https://github.com/Brother-Ben/medicus-vitae/releases/latest)**. Each installation starts empty: no account, books, decks or keys until you add them.

| System | File |
|---|---|
| Windows 10 or 11 (64-bit) | `Medicus-Vitae-<version>-windows-x64.zip` |
| Mac with Apple Silicon (M1 or later, macOS 13.5+) | `Medicus-Vitae-<version>-mac-arm64.dmg` |

Neither package needs anything else installed: each carries its own copy of Node.js.

**Windows**

1. Unzip, and move the **Medicus Vitae** folder somewhere permanent (for example Documents). Your data is kept inside it, in `data`.
2. Double-click **Medicus Vitae.exe**. If Windows says "Windows protected your PC", click **More info › Run anyway**. The app isn't signed with a paid certificate, so Windows asks once.
3. Your browser opens at <http://localhost:8080>. Create your account. Optional: **Add shortcuts.cmd** puts the app in the Start menu and on the Desktop.

**Mac**

1. Open the `.dmg` and drag **Medicus Vitae** onto **Applications**.
2. The app isn't signed with a paid Apple developer certificate, so macOS blocks it until you allow it once. In Terminal, run
   `xattr -dr com.apple.quarantine "/Applications/Medicus Vitae.app"`
   or open it, click **Done**, then go to **System Settings › Privacy & Security** and click **Open Anyway**.
3. Open **Medicus Vitae**. Your browser opens at <http://localhost:8080>. Create your account.

## Everyday use

**Windows:** double-click **Medicus Vitae**. The server starts hidden, your browser opens, and a teal **M** icon appears in the tray. The tray menu has Open Medicus Vitae, Open data folder, Open server log, Start with Windows, Restart server and Quit Medicus. Your data is in `data\` in the app folder.

**Mac:** open **Medicus Vitae** from Applications. It starts the server in the background and opens your browser; there's no Dock icon. Open the app again to get back to Medicus after closing the tab. Your data, settings (`.env`) and logs are in `~/Library/Application Support/Medicus Vitae`.

- **Quit** (the sidebar in Medicus, or the Windows tray menu) stops the server.
- Back up with the automatic snapshots or **Settings › Data › Export everything**.
- Settings live in `.env` (see `.env.example`, which explains each one). Change `PORT` if 8080 is taken.

**Updating:** on Windows, quit Medicus and copy the new version's files over the old folder (keep `data`). On a Mac, quit Medicus and replace the app in Applications. Your data stays where it is, and the app takes a snapshot before any database upgrade.

## New in 0.7

| Area | What you can do |
|---|---|
| Look | Tighter, flatter design (Linear/Things style), same themes. Tab rows instead of pill switches for page sections. |
| Menu & Today | **Settings › Menu & Today**: hide or reorder sidebar items and Today sections. Fold the sidebar to icons (button at its top, or press `[`). Today shows four sections by default; the rest are one switch away. |
| Deleting | Delete a deck, a card or a book from its menu. Each asks first, takes a safety snapshot and offers **Undo**. "Also delete it in Anki" is off unless you tick it. A deleted book keeps its cards unless you tick that too. |
| Book progress | Progress now counts only chapters and pages you **mark done** (chapter checkboxes on the book page, **Mark done** in the reader, **Set to a page…**, **Reset**). The old number was the furthest page you had opened, so existing books start at 0%. |
| Decks ↔ books | Link a deck to a book (Library › book › Linked decks, or the deck's menu). Chapters map to tags or subdecks: suggested by name or matched by AI, confirmed once. Cards you've never studied in unfinished chapters can stay suspended. Finishing a chapter unsuspends its cards (with Undo). Your own suspensions are never undone. Changes go to Anki at the next sync. |
| Card types | **Flashcards › Card types**: make or edit note types (fields, front/back templates, styling, scripts) with a live preview and AI help. **Image occlusion**: draw boxes or ovals on a picture, group them, hide all or one. These cards go to Anki if it has its own "Image Occlusion" note type (Anki 23.10+). Custom note types stay in Medicus for now. |
| CARS | **Flashcards › CARS › Get today's passage**: one click opens Jack Westin in a new tab, and the Medicus browser extension (added once in Brave with `brave://extensions` › Developer mode › **Load unpacked**, choosing the folder the CARS page shows) opens the newest passage you haven't imported, reads the passage, every question, the answer key and the explanations from the data the page itself holds (nothing is clicked or submitted there), and switches the tab to Medicus with the passage imported. On any passage page its **Send to Medicus** button (bottom right) does the same. After updating Medicus, press the reload arrow on the extension's card in `brave://extensions`. Brave loads the extension from that folder and drops it if the folder goes away, so Medicus keeps its own copy at `%LOCALAPPDATA%\Medicus Vitae\browser-extension` on Windows and `~/Library/Application Support/Medicus Vitae/browser-extension` on a Mac (refreshed each time it starts) instead of using `browser-extension` inside the app folder: moving or renaming the Medicus folder no longer breaks it. If Brave ever loses it anyway, the setup steps stay on the CARS page under **Medicus extension**. Without the extension, the **Send to Medicus** bookmark does it for the page you press it on. Each study day Today reminds you (turn it off or ask for more per day). Timed player, then time, right/wrong, by skill and trend. You can also paste any passage, AAMC CARS included. Jack Westin blocks automated visitors, so the app can't fetch passages by itself. The extension and the bookmark run in your own browser (nothing gets around the site's checks) and pass the page in the link's `#` part, which never reaches a server. |
| AAMC full-lengths | **Progress › Import from AAMC**: paste the score report or review page (read by AI when connected, otherwise by text rules), or type the wrong question numbers per section. You get a question grid, results by category and skill, and you can add wrong ones to the mistake journal. AAMC has no export, so this is the practical route. |
| AI | New connections: **Gemini** and **OpenRouter** keys, and **Other (OpenAI-compatible)** such as Ollama or LM Studio. **Tutor › Research the web** searches the web through your connected service (not your books). Answers are labeled "From the web" with source links. Claude API web search costs $10 per 1,000 searches. |

## New in 0.6

| Area | What you can do |
|---|---|
| Today | A clearer page: **Start studying** (review due cards, a one-tap focus round on a deck, or plan a session), your numbers, **What to work on** (plain rules, each with a reason and a Start button), **Waiting for review** by deck, **Study time, last 14 days** (chart with a table view) and recent sessions. |
| AI coach (Today) | **What to work on** (turns into a session in one tap), **Weekly recap**, **Mistake patterns**, and **Chapter summary** (cited, can be saved as a note). Nothing is sent until you press a button; the last answer of each kind is kept. |
| Plan a session | Pick the length (your own choices in Settings › Focus & breaks), let it suggest a plan (optionally for one deck or AAMC category), or add exactly what you want: due or new cards from a deck/category, a chapter or page range, specific mistakes, your own tasks (e.g. a UWorld block). Reorder, remove, then **Start session** goes straight to the first item. |
| Focus timer & breaks | Pomodoro rounds with short and long breaks (all lengths editable, per session too). A **session bar** on every page shows the live clock, time left, what you're on, and **Done, next**. Breaks open a calm screen: breathing guide (box, 4-7-8, slow), gentle reminders (relax, eyes, water, stretch, posture) and short guided meditations, plus a soft chime. Items finish by themselves (cards when the set is done, reading when you reach the last page, mistakes when you fix or retest them). |
| Set due date | Flashcards: for one card, ticked cards, or a whole deck (due now / studied / every card): today, in N days, on a date, or spread over a range. Only the date moves; it's kept in the card's history like a review. A new card just waits until that day. |
| Anki sync | Settings › Anki sync: two-way with Anki desktop through the AnkiConnect add-on (code 2055492159), and with Anki on your phone through AnkiWeb (Anki desktop syncs before and after). Reviews from both sides are merged; cards made here go to a "Medicus" deck; edits and deletions follow the rules shown on the page. Syncs on a button or by itself every few minutes while Anki is open. |
| Notes | Upload PDFs of your own notes and link pages of them to book pages (or a whole chapter); the reader shows "Your notes for this page". Filter by kind, book, chapter and AAMC category, search, sort by newest, oldest or book order. |
| Themes | Season themes (Spring, Summer, Fall, Winter, each with a day and a night version, every text pair checked for WCAG AA), **Follow the seasons** mode, and decorations for every season (petals, fireflies, leaves, snow) that you can pick whatever the date. Cleaner Appearance page. |
| Small things | Hide the test-day countdown; boxes rise a little under the pointer (can be turned off); **Start over** in Settings › Data clears the parts you pick after an "Are you sure?" (type RESET), with a safety snapshot and an Undo. |

## What's in this version

| Area | What you can do |
|---|---|
| Sign-in (SEC-01) | Password. Everything needs sign-in. (Two-factor sign-in was removed in 0.7.) |
| Library (LIB-01/03/08) | Import text-based PDFs (processed in the background); chapters come from the PDF's bookmarks with suggested AAMC tags you confirm; keyword search across books, notes and cards. |
| Reader (LIB-02, NOTE-01/02) | Fixed-layout PDF pages with zoom; highlight in four colors; reading notes (Markdown, with version history); draw a box around a figure, table or equation to cite or study it; make a card from any selection or box. Links always return to the exact spot. Page styles (Original, Dimmed, Sepia, Inverted, or Match theme) with highlights that keep their colors. |
| Cards (CARD-01/05/06) | Basic, reversed and cloze cards; FSRS scheduling (ts-fsrs) with every review stored as a permanent event; confidence (Guess/Unsure/Sure) recorded but never changes scheduling; review forecast with a warning before reviews pile up. |
| Mistake journal (PRAC-01) | Reason, AAMC category, reasoning skill; repair (revisit the passage, explain it) → retest on a different question → resolved, or reopened. |
| Full-lengths, practice (PRAC-02) | Log total and section scores and question-bank sets; review page per exam with its mistakes. |
| Progress (TRK-01/02) | Score trend vs. goal, section scores, AAMC heatmap with recall, practice and full-length evidence kept separate (thin evidence shows "not enough data"), mistake reasons, study time, streak, retention. |
| Today (PLAN-01/07) | Stats, focus areas, forecast, continue reading, and "I have N minutes": a planned session where every item says why it was picked. |
| Backups (SYNC-01/02) | Hourly snapshots (kept 48 h) and daily (kept 30 days) when something changed, plus before every upgrade; a second device can be a standby that pulls them, with "Make this device primary" for switching. |
| Data (DATA-01) | Full export (database, original books, readable JSON, notes as Markdown, cards CSV) that restores into a fresh installation; cards CSV for Anki. |
| Appearance (PLAT-03, A11Y-01) | Five themes (Clinic Light, Clinic Dark, Paper, Midnight, High contrast) picked, matched to the device's light/dark setting, or switched by time of day; a different theme per device if you like; reader page styles; section colors; focus mode for reviews; four text sizes; reading font and line spacing. Saved with your account. |
| Decorations | Gentle seasonal touches at the screen's edges (fall leaves, winter snow) and holidays (Christmas, Thanksgiving week, Ramadan with a ±1 day setting), never over what you're studying, still while you study, with reduced motion, or in the background. Settings › Appearance › Decorations, with previews. |
| App (PLAT-01) | Installable from the browser as an app (needs HTTPS on a phone; see below). |
| Anki import (CARD-02, M3) | `.apkg` / `.colpkg` in both Anki formats. Basic, reversed, cloze (including nested clozes) and your own note types, rendered with their templates, styling **and scripts** (in a sealed frame, see below); image occlusion cards (Anki's own and the Image Occlusion Enhanced add-on); tags; images and sounds; MathJax math; review history (deduplicated by Anki's review ids, replayed through FSRS); each deck's own order of new cards. A report before anything is imported lists what isn't supported (editing image occlusion masks, deck options other than desired retention), media the package left out, and whether history is included. Re-importing updates notes without duplicates and asks before replacing a card you edited here. |
| Decks | Flashcards lists your Anki decks as a tree with new, learning and due counts; **Study** a whole deck or any subdeck, and the session stays in it. New cards come in the deck's order (parents before subdecks), and of each day's new cards every first card comes before any second card of the same note, as in Anki. |
| Leeches (CARD-08) | Cards forgotten 8 times (adjustable) are flagged, and again every 4 lapses after that. Flag only: schedule and suspension are untouched. |
| AI tutor (AI-01/03, M4) | Answers only from your books, notes and cards, with numbered citations that open the cited spot. **Guide me** (leading questions, default) or **Explain**. Every citation is checked against what was sent, and a second call checks each claim against its passage; anything not backed is shown flagged. Says "not in your material" when it isn't. Available on the Tutor page, beside the book in the reader ("Ask tutor" on a selection), from a card in review, and on Today. |
| Generate (AI-02) | Cards, quiz questions or notes from a chapter. Each keeps links to its passages, is checked (quiz answer keys too), and waits under Tutor › Approvals; flagged items can't be approved in bulk. Approved items are marked AI-made and never used as evidence. Approved questions make up the Quiz, whose answers count as practice on the heatmap. |
| AI connection (AI-07) | Your **Claude plan through Claude Code** on this computer, **Sign in with ChatGPT** (your plan's allowance), or a Claude or OpenAI API key with an optional monthly spending cap. Usage limits are reported clearly with a link to manage usage. Settings › AI shows what each feature sends where. |
| Search index (AI-08, LIB-08) | Built on this device: book passages, figures and tables found by their captions (cited as page regions), your notes and cards; a local embedding model gives **Meaning** search (Search page) and powers the tutor. Nothing is sent anywhere to build it. |

## Importing from Anki

In Anki: **File › Export**, choose **Anki Deck Package (.apkg)**, tick **Include scheduling information** (for your review history) and **Include media**. Here: **Flashcards › Import from Anki**, choose the file, read the report, and press **Import**. Nothing is added until you do. Shared decks from AnkiWeb import the same way. Importing the same deck again updates it (and brings in anything an older version skipped) without duplicates.

**Card scripts.** Many note types build the card with JavaScript (for example "Cloze Overlapping" decks, whose question would otherwise be blank). As in Anki, those scripts run, but each card sits in a sandboxed frame with its own opaque origin: its scripts can't read this app, its storage or your sign-in, can't send requests as you, and load images through a daily key that opens nothing but card media.

## Connecting AI

**Settings › AI**:

- **Claude plan (through Claude Code)** uses your Claude Pro or Max plan by running Claude Code, Anthropic's app, already installed and signed in on the computer running the app. It runs `claude -p` with every tool turned off, no MCP servers, plugins, hooks or CLAUDE.md (`--safe-mode`), and nothing saved to Claude Code's history; requests count toward your plan's usage limits. If you use more than one Claude Code account (separate settings folders such as `~/.claude-work`), choose which one. The app never reads or stores your Claude login. Anthropic's terms don't allow apps to offer "Sign in with Claude" or to handle Claude credentials (<https://code.claude.com/docs/en/legal-and-compliance>); running your own signed-in Claude Code for your own use is different, and that is all this does. In Docker on the server this option needs Claude Code installed and signed in inside the container, so there you'd use ChatGPT or an API key instead.
- **Sign in with ChatGPT** uses your ChatGPT Plus/Pro allowance through OpenAI's "Sign in with ChatGPT" for open-source apps. On the computer running the app, the sign-in comes straight back. If it runs on another machine (a home server), the last sign-in step lands on a page that doesn't load; copy its address into the box the app shows.
- **Claude** or **OpenAI API key**, with an optional monthly cap in dollars. Keys can also go in `.env` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`). Keys saved in Settings travel to the standby with snapshots but never into exports.

Only the passages picked for a question (up to 8) and the question are sent, never whole books. The **quality check** in Settings › AI runs a fixed test set (answerable and unanswerable questions, misleading passages, instructions planted in book text, a deliberately wrong answer key) against your service; run it after changing model or service.

The search index and the embedding model (`Xenova/bge-small-en-v1.5`, about 34 MB, downloaded once into `data/models`) are per device and rebuilt as needed; they're not in snapshots or exports. Without AI, everything else, Meaning search included, keeps working.

## Phone and iPad over Tailscale

Browsers only install apps from HTTPS addresses. On the machine running the app:

```
tailscale serve --bg 8080
```

Then open `https://<machine>.<tailnet>.ts.net` on your phone and use **Add to Home Screen**. The app listens on `127.0.0.1` by default, so it's reachable from other devices only through Tailscale Serve.

## Home server or NAS with Docker

1. Put `docker-compose.yml` (and optionally `.env`) in a folder on the server.
2. It uses the published image `ghcr.io/brother-ben/medicus-vitae` (built by `.github/workflows/docker-image.yml` for each release). To build it yourself instead, use `build: .` with a copy of this repository.
3. Set `TZ` in `docker-compose.yml` to your time zone, then `docker compose up -d` (add `--remove-orphans` once if you are coming from the Cortex days), and `tailscale serve --bg 8080` on the server.

To update later: `docker compose pull && docker compose up -d` (or `docker compose up -d --build` when building from this folder).

Everything is stored in `./data`; recreating the container or updating the image keeps it. The app takes a snapshot before applying any database upgrade.

## Using a second computer as a standby

1. On the server: **Settings › Backups & sync**, copy the pairing key.
2. On the second computer, in a fresh installation (new data folder): choose **Standby for another device** on the welcome screen and enter the server's address and key. It copies the server's data and stays read-only, pulling the newest snapshot every few minutes.
3. On the server, enter the second computer's address under **Other device** (so a returning server notices a newer primary). Its address over Tailscale: run `tailscale serve --bg 8080` on it too.
4. **If the server goes down:** stop it if it's still half-running, then on the second computer choose **Make this device primary**. It shows how old its copy is and asks you to confirm.
5. **When the server is back:** start it. It sees the second computer is newer, becomes a standby, keeps its own database aside, and copies the newer data. Then choose **Make this device primary** on the server; the second computer hands off cleanly and goes back to standby.

If both machines took changes (the server wasn't really stopped), both copies are kept and Settings asks which one to keep. Don't sync the live `data` folder with OneDrive, Dropbox or Syncthing; use snapshots and pairing instead.

## Development

The app is SvelteKit 3 + TypeScript, SQLite (WAL) through Drizzle ORM, FTS5 for search, PDF.js for reading and text extraction (in a worker thread), and ts-fsrs. It needs Node.js 24 (22.17 or later works). On Windows you can keep a portable Node.js in `runtime\node` (not in the repository) instead of installing it system-wide; the tray app uses it when it's there.

```powershell
$env:PATH = "$PWD\runtime\node;" + $env:PATH   # only with a portable Node.js in runtime\node
node scripts/install-deps.mjs   # dependencies, as package-lock.json lists them (npm ci without
                                #   npm trying to compile better-sqlite3; see the script)
npm run dev            # development server with live reload
npm run build          # production build (when the app isn't running)
npm run build:next     # production build beside a running copy; used at the next start
npm start              # run the built app (what the tray app does)
npm test               # unit and integration tests
npm run check          # type checking
npm run db:generate    # after changing src/lib/server/db/schema.ts: writes a new migration
npm run desktop:build  # rebuild "Medicus Vitae.exe" (tray app) and the shortcuts
npm run desktop:icons  # redraw the app icons
npm run package        # after npm run build: the download for this system, in dist/
npm run package:check  # unpack that download in a temporary folder and start it once, empty
```

**Releases.** The downloads are made by `.github/workflows/release.yml` on GitHub's Windows and Mac machines: raise `version` in `package.json`, commit, then `git tag v<version>` and `git push origin v<version>`. It runs the tests, builds both packages with `scripts/package.mjs`, unpacks and starts each one with `scripts/smoke-test.mjs`, and publishes them as a GitHub Release. A package holds the build, the server, the migrations, the browser extension, production dependencies installed fresh for that system and its own Node.js, and never `data/`, `.env` or `tests/`. The Mac app is a small launcher (`desktop/mac/launcher.sh`) inside `Medicus Vitae.app`.

Browser and two-device tests are in `tests/e2e` (see the comment at the top of each file). They start the server with `CORTEX_FAKE_AI=1` (a stand-in AI service so the tutor can be tested without an account; never set it otherwise) and `CORTEX_EMBEDDINGS=off`. To test a `build:next` build: `$env:CORTEX_BUILD_DIR='build-next'; npm run test:e2e`.

The M4 speed check (retrieval at 10,000 / 50,000 / 100,000 passages, review saves while a book is indexed) runs on demand: `$env:CORTEX_BENCH='1'; npx vitest --run src/lib/server/ai/speed.spec.ts`. Run it on the server to confirm the numbers there.

Database changes are applied as migrations in `drizzle/`; never edit or regenerate an existing migration once an installation has used it, only add new ones. Tables added later need change-tracking triggers like those in `0001_search_index_and_change_tracking.sql` (a test checks this).

### Themes

Every color comes from `src/lib/styles/themes.css` (the five themes and the reader page styles, as designed); `src/lib/styles/app.css` only derives hover shades from them. The active theme is `data-theme` on `<html>`, set before the first paint by the script in `src/lib/appearance-boot.ts`. The logo is one component, `src/lib/components/Logo.svelte` (the favicon, app icons and tray icon are drawn by `static/favicon.svg` and `desktop/make-icons.ps1`).

### Layout

- `server/index.js` production entry (port, single-instance lock, clean shutdown, switching to a `build:next` build); `server/pdf-worker.js` PDF text extraction; `server/embed-worker.js` the local embedding model.
- `src/lib/server/` database, auth, library, cards/FSRS, practice, stats, planner, snapshots, export, sync, appearance.
- `src/lib/server/anki/` Anki packages (both formats), Anki's template and cloze rules (image occlusion included), card HTML, media, the importer. The card frame and what runs inside it: `src/lib/components/AnkiCard.svelte`, `src/lib/anki-frame-runtime.ts`.
- `src/lib/server/ai/` search index and retrieval, AI connections (Claude Code, ChatGPT sign-in, Claude and OpenAI keys), the tutor with its checks, generation, the quality check.
- `src/lib/decor/` when decorations show (seasons, Thanksgiving, Christmas, Ramadan); `src/lib/components/Decorations.svelte` draws them.
- `src/routes/` pages and `/api` endpoints; `src/lib/components/` shared UI.
- `desktop/` the Windows tray launcher (C#, compiled with the compiler built into Windows), the icon generator, the Windows shortcut script (`desktop/windows`) and the Mac app's launcher (`desktop/mac`).
- `scripts/package.mjs` and `scripts/smoke-test.mjs` make and check the downloads.

### Names kept from "Cortex"

So existing installations keep their data and settings: the `CORTEX_*` settings in `.env`, the data folder and its files (`data/cortex.sqlite`, `local.sqlite`), the project folder (`cortex`), the sign-in cookie, browser storage keys for the device id and old appearance settings, the export format id inside export zips (old and new exports both restore), and the tray app's single-instance lock.

## License

MIT. See [LICENSE](LICENSE).
