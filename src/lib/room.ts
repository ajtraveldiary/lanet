// Talking to the room on the server. The room only introduces devices; files never go through it.

export const ROOM_ID = /^[A-Za-z0-9_-]{22}$/;

// Same list as worker/index.ts.
const CLOSE = { notHost: 4401, noRoom: 4404, closed: 4410, full: 4413, tooManyTries: 4429, replaced: 4000 };

export function roomSocket(id: string): WebSocket {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return new WebSocket(`${proto}//${location.host}/api/room/${id}/ws`);
}

export const roomLink = (id: string) => `${location.origin}/#${id}`;

export async function createRoom(): Promise<{ id: string; token: string }> {
  const res = await fetch("/api/room", { method: "POST" });
  if (!res.ok) throw new Error("Could not start a room");
  return res.json();
}

// Six digits, every PIN equally likely.
export function newPin(): string {
  const limit = Math.floor(0xffffffff / 1e6) * 1e6;
  for (;;) {
    const n = crypto.getRandomValues(new Uint32Array(1))[0];
    if (n < limit) return String(n % 1e6).padStart(6, "0");
  }
}

// A close that means "stop trying" gets a message; anything else (a dropped Wi-Fi) is retried.
export function closeMessage(code: number, reason: string): string | null {
  switch (code) {
    case CLOSE.noRoom: return "This room has closed. Ask for a new link.";
    case CLOSE.closed: return reason ? reason + "." : "The room has closed.";
    case CLOSE.full: return "This room is full.";
    case CLOSE.tooManyTries: return "Too many wrong PINs were typed in this room. Ask the main device to start a new room.";
    case CLOSE.notHost: return "This page can no longer open that room.";
    case CLOSE.replaced: return "This room was opened in another tab or window.";
    default: return null;
  }
}

export const retryDelay = (tries: number) => Math.min(1000 * 2 ** tries, 10_000);

// sessionStorage can be missing or full (private windows); the room still works, it just won't survive a reload.
export function readSession<T>(key: string): T | null {
  try { return JSON.parse(sessionStorage.getItem(key) ?? "null"); } catch { return null; }
}
export function writeSession(key: string, value: unknown) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch { /* not kept */ }
}
