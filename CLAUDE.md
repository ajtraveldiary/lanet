# CLAUDE.md — working on Lanet

Instructions for a coding agent in this repository. `README.md` has the overview and the map of the code.

## What this is

Lanet sends files, folders and text between devices on the same Wi-Fi, from the browser. The main device taps **Start sharing** and shows a QR code, a link and a 6-digit PIN; other devices join with them. The files go **straight from device to device** over the local network (WebRTC). The Cloudflare Worker only introduces the devices and never sees a file. Users are ordinary people, not developers.

## Commands

```bash
npm install
```

```bash
npm run dev        # Vite + the Worker together, on http://localhost:5173 and the Wi-Fi address
```

```bash
npm run build      # type-check the app and the Worker, then build into dist/
```

```bash
npm run preview    # serve the built app on :4173 (localhost and the Wi-Fi address) — test on this
```

```bash
npm test           # build, start the built app on :4174, run the Playwright tests in tests/ (first time: npx playwright install chromium)
```

```bash
npm run speed      # build, then measure 400 MB between two windows for each way of saving (~1 min); not part of npm test
```

```bash
npm run deploy     # build, then publish to Cloudflare (the user runs this, never the agent)
```

## How the user wants to work

These come from the user's own instructions in the conversation that started this project.

- **Check first, then ask, then plan, then confirm.** For a new idea: first check whether it is technically possible and say plainly what can't be done. Then ask questions until everything is clear (multiple-choice questions with a recommended option have worked well). Then write the plan. Start nothing until the user approves it.
- **One step at a time.** The work follows the numbered plan below. Do one step, test it, report, then stop. The next step starts only when the user says so ("go").
- **Lanet has nothing to do with any other project.** In particular, don't look at, copy from or take ideas from *eOffice Assist* (another project in `C:\Users\media\Desktop\`), not even its package versions. Design everything for Lanet on its own.
- **The user runs git and deploy commands.** Give each command in its own `bash` block; never join them with `&&`; never add `Co-Authored-By` or other attribution lines.
- **When an answer is unclear, ask** rather than guess (for example, a one-line reply that could mean two things).
- **Questions asked only "for information"** (like "is any device to any device possible?") get an answer, not a feature. Don't build it unless the user asks.

## The project's home

- Folder: `C:\Users\media\Desktop\lanet`
- GitHub: https://github.com/ajtraveldiary/lanet (public, branch `main`). The user created it and pushes to it.
- Live: **https://lanet.workdesk.workers.dev/** (Cloudflare Workers, the user's account). The user deploys with `npm run deploy` from their own terminal.

## Rules for every change

1. **Never remove or change a confirmed feature without asking.** Anything the user asked for, suggested, or approved in a plan stays exactly as agreed: a feature, a behaviour, a wording, a layout, a limit. Don't change it back, "simplify" it away, or swap it for something else while working on another task. If a change would touch it, stop and ask first. If two earlier requests conflict, ask which one wins. The list below under "Decisions the user has confirmed" is the record; add to it when the user confirms something new.
2. **Ask before starting.** When the user asks for a plan or suggestions, change nothing until they approve. Ask questions before planning when anything is unclear. Work in the agreed steps and stop after each step to report.
3. **Minimal changes.** Edit only what the request needs. No drive-by refactors, renames or tidying. Mention anything else you notice; don't do it.
4. **Be honest about limits.** If something can't be done (or can't be done in a browser), say so plainly and offer the closest thing that can. Never claim something works without having tested it; say what was and wasn't tested.
5. **Test in a real browser before saying it works.** Run `npm test` (all of it must pass), and for anything on screen also drive the real screens with `npm run preview` and two tabs (one main device, one guest). Type-checking is not a test. A new feature or fixed bug gets a test in `tests/`. Check the odd cases too: wrong PIN, a reload on either side, cancel mid-transfer, an empty file, a hostile file name or text.
6. **Every change works on a phone, a tablet and a desktop.** One app that narrows. Check at 320, 360, 768 and 1280 px: no sideways page scrolling, nothing overlapping, buttons at least 44 px tall, dark mode readable.
7. **Plain English in the app.** Short sentences, no jargon. Error messages say what happened and what to do next.
8. **Comments say why, not what.** Match the density and style of the file you're in.
9. **After a change, report it**: what changed (with file links), what was tested, what wasn't. Then give the commands the user runs, each in its own `bash` block, in this order: `npm run build`, `git add -A`, `git commit -m "…"`, `git push`. Never join commands with `&&`. Never add `Co-Authored-By` or any other attribution to commit messages or pull requests. Don't commit, push or deploy yourself unless the user asks.

## Safeguards

- **Secrets never go into the repository.** `.env`, `.env.*`, `.dev.vars`, keys and certificates are git-ignored; keep it that way. Cloudflare secrets are set with `npx wrangler secret put NAME`, and local ones live in `.dev.vars`. Never print a secret in a log, a URL, a commit or a chat. If one is ever pasted or committed, tell the user to rotate it straight away (removing the commit is not enough).
- **Before every commit**, check `git status` for files that shouldn't be there: secrets, build output, large test files, personal settings. Never commit test data such as generated `.bin` files.
- **Files never touch our server.** No relay, no TURN server, no upload "fallback". `RTCPeerConnection` is created with `iceServers: []` on purpose, so only local-network addresses are ever offered. If two devices can't connect directly, the app says so and stops (the user chose this).
- **The server keeps almost nothing.** The room keeps a hash of the main device's token, the wrong-PIN count, and rejoin-pass hashes, and deletes all of it when the room closes. The PIN goes straight through to the main device and is never stored. Don't add logging of room ids, names, PINs or message contents.
- **Security headers** (`public/_headers`, asked for by the user): a strict Content-Security-Policy (everything from Lanet's own address only, no inline scripts or styles, no `data:` files, no framing), plus `X-Frame-Options`, `nosniff`, `no-referrer`, a Permissions-Policy, COOP/CORP and HSTS. Don't loosen them to make something work; find another way (the build never embeds files as `data:` for this reason, `assetsInlineLimit: 0`). `tests/security.spec.ts` fails if anything the app does is blocked. No `upgrade-insecure-requests`, because the app is tried over plain http on the home network during development.
- **Link preview** (asked for by the user): the `og:` and `twitter:` tags in `index.html`, the image `public/og.jpg` (1200 × 630 JPEG, under 300 KB for WhatsApp) and `public/apple-touch-icon.png`. Both images are made from `scripts/share-image.html` and `public/icon.svg` with `npm run share-images`; change the HTML and run that, never edit the images by hand. The tags hold the full live address (`https://lanet.workdesk.workers.dev/`); if the address changes, change them too. Only these two images may be loaded by other sites (`Cross-Origin-Resource-Policy: cross-origin` in `public/_headers`). `tests/share.spec.ts` checks all of this.
- **No tracking.** No analytics, cookies, third-party scripts or fonts from other sites. Only the libraries in `package.json`.
- **Everything another device sends is untrusted.** File names go through `safeName` (no folders, no characters Windows refuses). Text is shown as text by React; only `http`/`https` addresses become links, opened with `rel="noopener noreferrer"`. Sizes and counts in an offer are checked; more bytes than offered is an error. Never use `dangerouslySetInnerHTML` with anything from another device.
- **Never overwrite the user's files.** A name that exists gets " (2)", " (3)"… A cancelled or failed file is removed, not left half-written.
- **Ask before anything outward-facing:** deploying, changing Cloudflare settings, deleting a Cloudflare resource, making the GitHub repository public or private, or starting a real file download in the user's browser during a test.
- **Don't delete user data** (their files, their repository history, their Cloudflare resources) without an explicit yes.
- **Dependencies:** add a package only when it is clearly needed, prefer small well-known ones, and say why. npm is set to block install scripts; don't approve them without asking.

## Decisions the user has confirmed

These were asked for or approved by the user. Keep them unless the user changes them.

- **The original request:** a Cloudflare Worker web app with a button that "starts a server" and gives a local link; devices on the same network open it and send files to and receive files from the original device.
- **What was agreed instead, and why:** a web page can't start a server or listen on the local network, so a literal local link is impossible from a browser. The user chose: Worker + Durable Object to introduce devices, and WebRTC so files still go device to device over the local network. Internet is needed only to connect. (A small desktop program would give a true offline local link; the user didn't choose it.)
- A separate project in its own folder, unrelated to eOffice Assist or any other project.
- Name: **Lanet**. The user asked for a made-up word from two words and chose "Lanet". English-only screens.
- Stack: Vite + React + Tailwind, served by the Worker.
- Devices send to and receive from **the main device only** (not to each other). Device-to-device is possible later if the user asks.
- Joining: **link + QR code + 6-digit PIN**, checked by the main device.
- Wrong PINs: **10 per room**, then no new devices; devices already let in can still rejoin with their pass. (Changed from "5 per device" with the user told why: devices on one Wi-Fi share one internet address.)
- The room closes **2 minutes** after the main device leaves, or at once when it taps **Close room**.
- If a network blocks direct connections: **show a clear message**, never send files through Cloudflare.
- Files from **1 KB to 20 GB**, many at once; **folders**; **text and links**.
- Receiving: Chrome/Edge on a computer save into a folder the user picks; others stream into downloads; iPhone/iPad keep files in the browser, then Save. iPhone/iPad as receiver: **show a warning** for big sends (over 2 GB), don't block.
- **Resume** a big transfer after a dropped connection: on every browser while both pages stay open; after the sending page reloads, by picking the same files again; not after the receiving page reloads (confirmed after step 5, replacing "desktop Chrome/Edge only").
- Folders: kept as folders on Chrome/Edge desktop; arrive as one `.zip` elsewhere (step 4).
- Sending: the receiver sees names and sizes and taps **Accept** or **Decline**; nothing moves before that. Both sides can cancel.
- Repeated device names get a number ("Android phone · Chrome (2)").
- Text messages live only in the open page (a reload clears that page's copy); nothing is stored on the device or the server.
- **Look (step 6):** the user gave a reference design for *inspiration only*. Copy none of its features (no friends, profiles, notifications, activity feed, "nearby" toggle, web card); take only the style. Chosen: violet for main actions and teal for receiving, a soft mint-to-lavender background, white rounded cards; on phones a floating pill tab bar (main device: Room · Files · Text; joining device: Files · Text), on computers the parts side by side; joined devices as a restyled list (not a radar); a transfer in progress as a progress ring with Files / Size / Speed and one row per file with a type icon and its own small ring.
- The project keeps a `CLAUDE.md` with these rules and safeguards, a `README.md`, and a `.gitignore` that keeps `.env` files, `.dev.vars`, keys and other secrets out of GitHub.

## Plan and progress

0. Connection test — done. On the user's Wi-Fi, phone ↔ PC connected directly; 100 MB arrived complete at 4.6 MB/s.
1. Rooms, PIN, QR code, React app — done.
2. Direct connection, text and links — done. The user confirmed messages went both ways on their phone.
3. Files with progress, cancel, the four ways of saving — done and tested in two tabs on the PC (512 MB at about 28 MB/s, byte for byte correct). **Not yet tried on the user's phone.** The `download` way of saving is untested, because that test starts a real download.
4. Folders, zip fallback — done and tested in two tabs on the PC. Details chosen in this step (not separately asked): empty folders aren't sent (the browser's folder picker doesn't list them); at most 10,000 files per send; the `.zip` is not compressed (fast, and photos and videos don't shrink); a top-level folder whose name is taken is saved as "Name (2)" as a whole; the zip uses the `client-zip` library (MIT, no dependencies).
5. Resume after a dropped connection — done and tested in two tabs on the PC. What was built: each joining device has its own key, so a rejoining device keeps its place, conversation and transfers on the main device. A dropped connection **pauses** a transfer, and it carries on from the exact byte when the connection is back. This works on every browser, as long as both pages stay open. If the *sending* page was reloaded, picking the same files again carries on from where it stopped. If the *receiving* page is closed or reloaded, the half-received data is gone (browsers discard it) and the transfer has to start again. The sender is told so. The user confirmed this ("keep it as built"), in place of the original "desktop Chrome/Edge; elsewhere it starts again".
6. Screens polish — done and tested in two tabs on the PC (320, 360, 768 and 1280 px; light and dark). New look per the user's choices above, in `src/styles.css` (theme), `src/ui.tsx` (cards, buttons, ring, tab bar), `src/icons.tsx` (hand-drawn icons, device and file kinds). Font: Plus Jakarta Sans, bundled from npm (`@fontsource-variable/plus-jakarta-sans`), never loaded from another site.
7. Automated tests — done (30 tests since step 9; `tests/speedup.spec.ts` covers several files at once, the extra connections, a lane dropping mid-file, a zip staying in order, and the version check): originally 22 Playwright tests in `tests/`, each with two separate browser windows (main device and guest), all passing. They cover rooms and PINs, the room server's rules, text, files (folder, browser and memory ways of saving), folders and zips, resume (drop, sender reload, receiver reload), and layout at 320–1280 px and dark mode. Every change runs `npm test` before it's reported. Not covered automatically: the `download` way of saving (it starts a real download) and real phones; those need the user's real-device check.
8. Deploy — done: live at https://lanet.workdesk.workers.dev/ and checked from two tabs (join, text, a 20 MB file byte for byte). Security headers added afterwards at the user's request; 24 tests pass. Still to do by the user: the real-device check (Android, iPhone or iPad, resume with Wi-Fi off and on).

9. Faster transfers — approved by the user ("start 09"), done one part at a time, each measured with `npm run speed` (two runs before and after, since one run is noisy):
   - 9a. Group writes — done. The receiver writes in 4 MB groups; the sender may be 32 MB ahead. On this PC: about 22 → 23 MB/s, a small but steady 3–5%. The connection pipe, not writing, is the limit here; the gain should be bigger on phones with slower storage.
   - 9b. Several files at once — done (the user said "do 9a, 9b and 9c"). Files under 32 MB go up to 4 at a time; each keeps its own resume point. A folder packed into a `.zip` stays one file at a time, in order.
   - 9c. Big files over extra connections — done. Once the main connection is up, the joining device opens two extra connections ("lanes" 1 and 2) to the main device through the room (`signal` with `lane`). Files of 32 MB or more are dealt in 1 MB blocks across the main connection and the lanes that are up; the receiver puts them back in order (at most 32 MB waiting), so it works with every way of saving. If any connection drops mid-file, that file pauses and the receiver asks for the rest straight away (about half a second) from the exact byte; a dead lane is left out and set up again after 5 s. (Built this way instead of moving a dropped lane's blocks to the others without pausing; simpler, same safety; the user was told.)
   - Measured on this PC (busy with other apps; old 9a and new versions run alternately, two rounds each, MB/s): 200 smaller files 15.4 · 19.2 → 20.1 · 19.0; 400 MB into browser storage 20.5 · 16.5 → 23.6 · 17.7; 400 MB kept on the page 20.8 · 15.6 → 22.2 · 17.0. About +8–13%, every run complete. On one PC all connections share the same busy processor, so the real gain must be measured between two devices on Wi-Fi. One earlier run broke mid-transfer together with the room connection, most likely because the PC paused or slept; it didn't happen again in any later run.
   - Devices exchange a protocol version (`PROTOCOL` in `transfers.ts`) in `hello`; if it differs, the Files panel says to reload both pages and sending is switched off. Bump `PROTOCOL` whenever the file messages or channel labels change.

**Still with the user:** the real-device check on the live site (Android, iPhone or iPad, Wi-Fi off and on mid-transfer), and their speeds there.

## Architecture in one screen

- `worker/index.ts` — `POST /api/room` makes a room (random 22-character id and a host token). `/api/room/<id>/ws` is the room's WebSocket, handled by the `Room` Durable Object, which passes setup messages (`signal`) between the main device and each admitted guest. Close codes there and in `src/lib/room.ts` must match.
- `src/lib/room.ts` — room WebSocket helpers, PIN, close messages. The room id is in the `#` part of the link so it never reaches server logs.
- `src/host/` and `src/guest/` — the two sides: a hook holding the state (`useHostRoom`, `useGuestRoom`) and a page.
- `src/lib/peer.ts` — `PeerLink`: one WebRTC connection, a control channel `ctl` for JSON messages (split into parts when large), and the file channels. Each joined device has a main `PeerLink` plus up to two extra ones (lanes) used only for big files; the hooks set them up and pass them to `Transfers.setLane`.
- `src/lib/chat.ts`, `src/Conversation.tsx` — text and links.
- `src/lib/transfers.ts` — the file protocol: `offer` → `accept`/`decline` (the accept says which files from which byte, and how many at once) → for each file, one channel per connection used (`f:<batch>:<file>:<start>:<slot>:<slots>`), binary pieces, `end`; slot k carries blocks k, k + slots… from the start byte. The receiver answers on slot 0 with `ack:<bytes>`, `done` or `err:<reason>`, and puts pieces back in order before writing in 4 MB groups. The sender stays at most 32 MB ahead of what the receiver has written. `resume` carries the same list as `accept`.
- `src/lib/sinks.ts` — where received files go: `folder`, `download` (via `public/sw.js`), `browser` (via `src/lib/store-worker.ts`), `memory`. Only `folder` takes paths with folders in them.
- `src/lib/pick.ts` — files and folders from the pickers and from drag and drop, each with its path inside the folder.
- `src/lib/zip.ts` — a received folder packed into one `.zip` as it arrives, for every way of saving except `folder`. Its predicted size must match the real one exactly, because a streamed download announces it in advance.
- `src/Files.tsx` — the Files screen.

## Things that will bite you

- **Plain http on the Wi-Fi address is not a secure context.** There is no service worker, browser storage, clipboard or `crypto.randomUUID` there; use `randomKey()` for ids and expect the `memory` way of saving (500 MB at most). `localhost` and https are secure. Test the large-file paths on `http://localhost:4173` or the deployed https site.
- **`localStorage["lanet.sink"]`** forces a way of saving (`folder` uses browser storage as a stand-in folder, `download`, `browser`, `memory`). It is for tests only; remove it after testing.
- **React may run state updaters twice.** Never create objects with side effects (a `Transfers`, a connection) inside a `setState` updater. The host keeps its device list in `guestsRef` as the one source and copies it to state.
- **The room gives a device a new id every time it joins.** The main device recognises a returning device by its `key` (random, kept in the tab's sessionStorage, passed through the room in `knock` and `welcome`) and moves the same `Guest` entry to the new id. Key per-device state on `key`, never on `id`.
- **A drop pauses; it never fails.** In `transfers.ts`, a closed channel means `Dropped` and pauses the batch. Only a real error (disk full, unreadable file, out of step) fails it. Writers stay open while paused. Every `send` into a channel must check it is still open: a channel can close between two pieces before its close event arrives.
- **Folder-saved files leave an empty name if the page closes mid-file.** `sinks.ts` remembers those names and removes them, if still empty, the next time files are accepted into a folder.
- **The service worker only answers `/__download/…`** and must never cache the app.
- **The browser pane's `preview_start` with a name reads the launch settings of the folder this session was first opened in** (eOffice Assist), even after the session moved here, so `lanet-preview` isn't found. Never add Lanet entries to eOffice Assist; run `npm run preview` in a terminal tab and call `preview_start` with `url: "http://localhost:4173"`.
- **Speed numbers on this PC swing by 30% or more between runs** (other apps use the processor). Compare versions only by running them alternately, several rounds each.
- **Restart `npm run preview` after every `npm run build`.** A running preview keeps serving the old page, which points at script files the build replaced, so the page comes up blank with 500 errors.
- **Testing in the built-in browser pane:** typing doesn't reach some inputs, so set values with the native setter and dispatch an `input` event. Feed files to a file input with a `DataTransfer`. Changing only the `#` part of the address doesn't reload the page. During a transfer the page asks before closing, so navigate with `force`. Starting a real download needs the user's OK first.
- **The agent's shell is sandboxed:** whatever it installs outside the project folder (such as Playwright's browsers in `AppData`) is invisible to the user's own terminal. Run such installs in the user's terminal (`npx playwright install chromium`), never only in the agent's shell.
- **Writing tests:** use the helpers in `tests/helpers.ts` (`pair`, `pickFiles`, `accept`, `checkStored`, `checkZip`, `dropConnection`). Make test files inside the page, not with Node's `fs` or `Buffer`; the tests are type-checked with DOM types only (`tests/tsconfig.json`). A page reload during a transfer opens a "Leave site?" dialog, so accept it with `page.on("dialog", d => d.accept())`.
- **Comments in JSX** placed as the direct child of `return (` before a single root are a syntax error; put them inside the element.
