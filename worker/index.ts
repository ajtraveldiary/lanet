import { DurableObject } from "cloudflare:workers";

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
}

const ROOM_WS = /^\/api\/room\/([A-Za-z0-9_-]{22})\/ws$/;
const GRACE_MS = 2 * 60_000;   // how long a room waits for its main device to come back (a reload, a dropped Wi-Fi)
const MAX_GUESTS = 20;
// Wrong PINs in all before the room lets no one new in. Counted per room, not per address:
// every device on one Wi-Fi reaches us from the same address, so one typo-prone phone would shut out the rest.
const TRIES_PER_ROOM = 10;
const MAX_MESSAGE = 64_000;

// Close codes the app turns into plain messages; src/lib/room.ts has the same list.
const CLOSE = { notHost: 4401, noRoom: 4404, closed: 4410, full: 4413, tooManyTries: 4429, replaced: 4000 } as const;

function randomId(bytes: number): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256(text: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Device names are shown on other devices; keep them short and free of control characters.
function cleanName(v: unknown): string {
  return String(v ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 40) || "Device";
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/room" && req.method === "POST") {
      const id = randomId(16), token = randomId(32);
      await env.ROOMS.get(env.ROOMS.idFromName(id)).create(await sha256(token));
      return Response.json({ id, token });
    }
    const m = url.pathname.match(ROOM_WS);
    if (m) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

type Who =
  | { role: "new" }
  | { role: "host"; name: string }
  | { role: "guest"; id: string; name: string; state: "knocking" | "in" };

// One room per main device. It introduces devices and passes their connection setup messages;
// files never come here. The main device checks the PIN, so the room never keeps it.
// Guests can only reach the main device, never each other.
export class Room extends DurableObject<Env> {
  async create(hostHash: string) {
    await this.ctx.storage.put({ hostHash, wrong: 0 });
    await this.ctx.storage.setAlarm(Date.now() + GRACE_MS);
  }

  async fetch(req: Request): Promise<Response> {
    const [client, server] = Object.values(new WebSocketPair());
    if (!(await this.ctx.storage.get("hostHash"))) {
      // A plain accept: its close is sent once the connection is up, where a hibernating one's is lost.
      server.accept();
      server.close(CLOSE.noRoom, "This room has closed");
    } else {
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role: "new" } satisfies Who);
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    if (typeof data !== "string" || data.length > MAX_MESSAGE) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    const who = ws.deserializeAttachment() as Who | null;
    if (!who) return;

    if (who.role === "new" && msg.type === "host") return this.hostArrives(ws, msg);
    if (who.role === "new" && msg.type === "join") return this.guestKnocks(ws, msg);

    if (who.role === "host") {
      if (msg.type === "admit") return this.admit(String(msg.to), msg.ok === true);
      if (msg.type === "signal") {
        const g = this.guest(String(msg.to));
        if (g && g.who.state === "in") g.ws.send(JSON.stringify({ type: "signal", data: msg.data }));
        return;
      }
      if (msg.type === "close") return this.closeRoom("The main device closed the room");
    }

    if (who.role === "guest" && who.state === "in" && msg.type === "signal") {
      this.host()?.ws.send(JSON.stringify({ type: "signal", from: who.id, data: msg.data }));
    }
  }

  async webSocketClose(ws: WebSocket) { await this.gone(ws); }
  async webSocketError(ws: WebSocket) { await this.gone(ws); }

  async alarm() {
    if (this.host()) return;
    await this.closeRoom("The main device left");
  }

  private async hostArrives(ws: WebSocket, msg: Record<string, unknown>) {
    const hash = await this.ctx.storage.get<string>("hostHash");
    if (!hash || typeof msg.token !== "string" || (await sha256(msg.token)) !== hash) {
      return ws.close(CLOSE.notHost, "Not the main device of this room");
    }
    for (const h of this.all()) if (h.who.role === "host") h.ws.close(CLOSE.replaced, "The room was opened again elsewhere");
    ws.serializeAttachment({ role: "host", name: cleanName(msg.name) } satisfies Who);
    await this.ctx.storage.deleteAlarm();
    const guests = this.guests();
    ws.send(JSON.stringify({
      type: "welcome",
      guests: guests.filter((g) => g.who.state === "in").map((g) => ({ id: g.who.id, name: g.who.name })),
      locked: ((await this.ctx.storage.get<number>("wrong")) ?? 0) >= TRIES_PER_ROOM,
    }));
    // Devices that were waiting send their PIN again on this.
    for (const s of this.all(ws)) s.ws.send(JSON.stringify({ type: "hostBack" }));
  }

  private async guestKnocks(ws: WebSocket, msg: Record<string, unknown>) {
    const wrong = (await this.ctx.storage.get<number>("wrong")) ?? 0;
    // A device let in before keeps its way back in after a dropped Wi-Fi, even once the room is locked.
    const rejoin = typeof msg.pass === "string" && (await this.ctx.storage.get("pass:" + (await sha256(msg.pass)))) === true;
    if (wrong >= TRIES_PER_ROOM && !rejoin) return ws.close(CLOSE.tooManyTries, "Too many wrong PINs");
    if (this.guests().length >= MAX_GUESTS) return ws.close(CLOSE.full, "The room is full");
    const pin = String(msg.pin ?? "");
    if (!/^\d{6}$/.test(pin)) return ws.send(JSON.stringify({ type: "wrongPin", left: TRIES_PER_ROOM - wrong }));
    const host = this.host();
    if (!host) return ws.send(JSON.stringify({ type: "hostAway" }));
    // The PIN is passed straight on to the main device, which checks it; it is never kept here.
    const who = { role: "guest", id: randomId(6), name: cleanName(msg.name), state: "knocking" } satisfies Who;
    ws.serializeAttachment(who);
    host.ws.send(JSON.stringify({ type: "knock", from: who.id, name: who.name, pin }));
  }

  private async admit(id: string, ok: boolean) {
    const g = this.guest(id);
    if (!g || g.who.state !== "knocking") return;
    if (ok) {
      g.ws.serializeAttachment({ ...g.who, state: "in" } satisfies Who);
      const pass = randomId(16);
      await this.ctx.storage.put("pass:" + (await sha256(pass)), true);
      const host = this.host();
      g.ws.send(JSON.stringify({ type: "admitted", id, pass, host: host?.who.role === "host" ? host.who.name : "Main device" }));
      return;
    }
    const wrong = ((await this.ctx.storage.get<number>("wrong")) ?? 0) + 1;
    await this.ctx.storage.put("wrong", wrong);
    if (wrong >= TRIES_PER_ROOM) {
      this.host()?.ws.send(JSON.stringify({ type: "locked" }));
      return g.ws.close(CLOSE.tooManyTries, "Too many wrong PINs");
    }
    g.ws.serializeAttachment({ role: "new" } satisfies Who);
    g.ws.send(JSON.stringify({ type: "wrongPin", left: TRIES_PER_ROOM - wrong }));
  }

  private async gone(ws: WebSocket) {
    const who = ws.deserializeAttachment() as Who | null;
    try { ws.close(1000); } catch { /* already closed */ }
    if (!who) return;
    if (who.role === "host") {
      if (this.host(ws)) return;
      await this.ctx.storage.setAlarm(Date.now() + GRACE_MS);
      for (const g of this.guests(ws)) {
        // A PIN still waiting for an answer is asked again when the main device is back.
        if (g.who.state === "knocking") g.ws.serializeAttachment({ role: "new" } satisfies Who);
        g.ws.send(JSON.stringify({ type: "hostAway" }));
      }
    } else if (who.role === "guest") {
      this.host(ws)?.ws.send(JSON.stringify({ type: "left", from: who.id }));
    }
  }

  private async closeRoom(reason: string) {
    for (const s of this.all()) s.ws.close(CLOSE.closed, reason);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // `except` leaves out a socket that is closing, which can still be listed while its close is handled.
  private all(except?: WebSocket) {
    return this.ctx.getWebSockets()
      .filter((ws) => ws !== except && ws.readyState === WebSocket.OPEN)
      .map((ws) => ({ ws, who: ws.deserializeAttachment() as Who }))
      .filter((s) => s.who);
  }
  private host(except?: WebSocket) {
    return this.all(except).find((s) => s.who.role === "host") as { ws: WebSocket; who: Extract<Who, { role: "host" }> } | undefined;
  }
  private guests(except?: WebSocket) {
    return this.all(except).filter((s) => s.who.role === "guest") as { ws: WebSocket; who: Extract<Who, { role: "guest" }> }[];
  }
  private guest(id: string) {
    return this.guests().find((g) => g.who.id === id);
  }
}
