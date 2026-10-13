# Lanet

Send files, folders and text between devices on the same Wi-Fi, straight from the browser. Nothing to install.

1. On the main device, open Lanet and tap **Start sharing**. It shows a QR code, a link and a 6-digit PIN.
2. On another device on the same Wi-Fi, scan the QR code (or open the link) and type the PIN.
3. Send files or text either way. The other side taps **Accept**, and the files go straight from one device to the other.

## Privacy

- **Files and text never go through the internet.** The devices connect directly over your Wi-Fi (WebRTC, encrypted). Lanet only offers local network addresses, so a transfer can't leave the network.
- **The server only introduces the devices.** It keeps a room for as long as the main device is there and deletes it 2 minutes after the main device leaves. It never sees files, text or the PIN.
- **No accounts, no tracking, no cookies.**

## What works where

| Receiving device | Where received files go |
|---|---|
| Chrome or Edge on a computer | Straight into a folder you pick (remembered) |
| Android, Firefox and other browsers | Your downloads, written as they arrive |
| iPhone and iPad | Kept in the browser, then tap **Save** (or **Save all**). Big files (over 2 GB) may not fit |

Any device can **send** files of any size.

**Folders:** send one with **Send folder**, or drag it in on a computer. Chrome and Edge on a computer save it as a folder, with everything inside in place. Other devices get it as one `.zip` file. Up to 10,000 files at a time; empty folders aren't sent. iPhones and iPads can't pick a folder to send.

**Limits**

- Both devices need the page open, and phone screens need to stay on (Lanet asks the phone to keep the screen on while files move).
- Some networks, such as guest, office or hotel Wi-Fi, stop devices from reaching each other. Lanet then says it can't connect directly. A home Wi-Fi or a phone hotspot works.
- The first connection needs internet, to reach the server that introduces the devices.

## Running it yourself

You need Node.js 20 or newer.

```bash
npm install
```

```bash
npm run dev
```

This opens on `http://localhost:5173`, and on your computer's Wi-Fi address so phones on the same network can join. The terminal shows the address.

To test the built version:

```bash
npm run build
```

```bash
npm run preview
```

On a plain `http://192.168.…` address, browsers turn off the features big files need. Receiving is then limited to 500 MB at a time. Use `http://localhost` on the computer, or the deployed https site, to try big files.

## Deploying to Cloudflare

You need a Cloudflare account; the free plan is enough.

```bash
npx wrangler login
```

```bash
npm run deploy
```

The app is then live at `https://lanet.<your-subdomain>.workers.dev`.

## How it's built

- **Worker** (`worker/index.ts`): makes rooms and runs each one as a Durable Object. A room checks that the main device is who it says, passes each PIN to the main device for checking, and relays connection setup messages. It allows at most 10 wrong PINs per room.
- **App** (`src/`): React + Tailwind, built with Vite.
  - `host/` and `guest/` — the main device and the joining device.
  - `lib/peer.ts` — the direct connection (WebRTC data channels).
  - `lib/transfers.ts` — offering, accepting, sending and receiving files, with flow control so a 20 GB file never has to fit in memory.
  - `lib/sinks.ts`, `public/sw.js`, `lib/store-worker.ts` — the ways a received file is saved.
  - `lib/pick.ts`, `lib/zip.ts` — sending folders, and packing a received folder into a `.zip` (with [client-zip](https://github.com/Touffy/client-zip)).
  - `lib/chat.ts`, `Conversation.tsx` — text and links.

## Security notes

- Never commit secrets. `.env` files, `.dev.vars`, keys and certificates are git-ignored. Cloudflare secrets are set with `npx wrangler secret put NAME`.
- File names from other devices are cleaned before saving, and existing files are never overwritten.
- Text from other devices is shown as plain text; only `http` and `https` links are clickable.
