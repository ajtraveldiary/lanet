import { randomKey } from "./peer";

// Text and links sent over the direct connection. Kept in memory only: a reload starts a clean page.

export type ChatMsg = { id: string; mine: boolean; body: string; at: number; delivered?: boolean };
export type ChatEvent = { kind: "text"; msg: ChatMsg } | { kind: "got"; id: string };

export const MAX_TEXT = 100_000;

export function newText(body: string): { wire: Record<string, unknown>; msg: ChatMsg } {
  const id = randomKey();
  return { wire: { t: "text", id, body }, msg: { id, mine: true, body, at: Date.now() } };
}

// Turns a message from the other device into a chat change; answers a text with a receipt.
export function readChat(m: Record<string, unknown>, reply: (r: Record<string, unknown>) => void): ChatEvent | null {
  if (m.t === "text" && typeof m.id === "string" && typeof m.body === "string") {
    reply({ t: "got", id: m.id });
    return { kind: "text", msg: { id: m.id, mine: false, body: m.body.slice(0, MAX_TEXT), at: Date.now() } };
  }
  if (m.t === "got" && typeof m.id === "string") return { kind: "got", id: m.id };
  return null;
}

export function applyChat(list: ChatMsg[], ev: ChatEvent): ChatMsg[] {
  if (ev.kind === "got") return list.map((x) => (x.id === ev.id && x.mine ? { ...x, delivered: true } : x));
  return list.some((x) => x.id === ev.msg.id && x.mine === ev.msg.mine) ? list : [...list, ev.msg];
}
