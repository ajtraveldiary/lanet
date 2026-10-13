import { DurableObject } from "cloudflare:workers";

interface Env {
  ROOMS: DurableObjectNamespace<Room>;
}

// Short ids so a room link can be typed on a phone during step 0; the real app uses long random ids.
const ID_CHARS = "abcdefghjkmnpqrstuvwxyz23456789";
const ROOM_PATH = /^\/api\/room\/([a-z0-9]{5})\/ws$/;

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/api/room" && req.method === "POST") {
      let id = "";
      for (const b of crypto.getRandomValues(new Uint8Array(5))) id += ID_CHARS[b % ID_CHARS.length];
      return Response.json({ id });
    }
    const m = url.pathname.match(ROOM_PATH);
    if (m) {
      if (req.headers.get("Upgrade") !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
      return env.ROOMS.get(env.ROOMS.idFromName(m[1])).fetch(req);
    }
    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

// One room per main device. It only passes connection setup messages between the main device
// and each guest; files never come here. Guests can only talk to the main device.
export class Room extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    const role = new URL(req.url).searchParams.get("role");
    const [client, server] = Object.values(new WebSocketPair());
    if (role === "host") {
      for (const old of this.ctx.getWebSockets("host")) old.close(4000, "Another main device took over");
      this.ctx.acceptWebSocket(server, ["host"]);
    } else {
      const id = crypto.randomUUID().slice(0, 8);
      this.ctx.acceptWebSocket(server, ["guest", "g:" + id]);
      server.serializeAttachment({ id });
      server.send(JSON.stringify({ type: "hello", id, hostHere: this.ctx.getWebSockets("host").length > 0 }));
      this.toHost({ type: "joined", from: id });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, data: string | ArrayBuffer) {
    // Setup messages are small; anything big or odd is dropped rather than relayed.
    if (typeof data !== "string" || data.length > 64_000) return;
    let msg: Record<string, unknown>;
    try { msg = JSON.parse(data); } catch { return; }
    if (!msg || typeof msg !== "object") return;
    if (this.ctx.getTags(ws)[0] === "host") {
      const { to, ...rest } = msg;
      for (const g of this.ctx.getWebSockets("g:" + String(to))) g.send(JSON.stringify(rest));
    } else {
      const { id } = ws.deserializeAttachment() as { id: string };
      this.toHost({ ...msg, from: id });
    }
  }

  webSocketClose(ws: WebSocket) {
    if (this.ctx.getTags(ws)[0] === "host") {
      for (const g of this.ctx.getWebSockets("guest")) g.send(JSON.stringify({ type: "hostLeft" }));
    } else {
      const { id } = ws.deserializeAttachment() as { id: string };
      this.toHost({ type: "left", from: id });
    }
    try { ws.close(1000); } catch { /* already closed */ }
  }

  private toHost(msg: object) {
    for (const h of this.ctx.getWebSockets("host")) h.send(JSON.stringify(msg));
  }
}
