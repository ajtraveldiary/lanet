import { useCallback, useEffect, useRef, useState } from "react";
import { closeMessage, createRoom, newPin, readSession, retryDelay, roomSocket, writeSession } from "../lib/room";
import { deviceName } from "../lib/device";
import { PeerLink, type LinkState, type Signal } from "../lib/peer";
import { applyChat, newText, readChat, type ChatMsg } from "../lib/chat";
import { Transfers } from "../lib/transfers";

// `id` is the room's name for the device's current visit (new on every rejoin); `key` is the device's own
// lasting one, so a device that drops and comes back keeps its conversation and its paused transfers.
export type Guest = {
  id: string; key: string; name: string; present: boolean; link: LinkState;
  messages: ChatMsg[]; unread: number; transfers: Transfers;
};
type Saved = { id: string; token: string; pin: string };

// Kept for this tab only, so a reload goes back into the same room with the same PIN.
const KEY = "lanet.host";

function loadSaved(): Saved | null {
  const s = readSession<Saved>(KEY);
  return s && typeof s.id === "string" && typeof s.token === "string" && /^\d{6}$/.test(String(s.pin)) ? s : null;
}

// Two phones of the same kind would otherwise look the same in the list.
function uniqueName(list: Guest[], name: string): string {
  const taken = new Set(list.map((g) => g.name));
  if (!taken.has(name)) return name;
  let n = 2;
  while (taken.has(`${name} (${n})`)) n++;
  return `${name} (${n})`;
}

export function useHostRoom() {
  const [room, setRoom] = useState<Saved | null>(loadSaved);
  const [status, setStatus] = useState<"connecting" | "open" | "reconnecting">("connecting");
  const [guests, setGuests] = useState<Guest[]>([]);
  const [selected, setSelectedState] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const peers = useRef(new Map<string, PeerLink>());
  // Socket and connection handlers outlive renders, so they read the device list and the open
  // conversation from refs. The list ref is the one source; the state copy only redraws the page.
  const guestsRef = useRef<Guest[]>([]);
  const selectedRef = useRef<string | null>(null);

  const updateGuests = useCallback((fn: (list: Guest[]) => Guest[]) => {
    guestsRef.current = fn(guestsRef.current);
    setGuests(guestsRef.current);
  }, []);
  const patch = useCallback((id: string, fn: (g: Guest) => Guest) => {
    updateGuests((list) => list.map((g) => (g.id === id ? fn(g) : g)));
  }, [updateGuests]);
  const guest = (id: string) => guestsRef.current.find((g) => g.id === id);

  // File progress changes many times a second; the page is redrawn at most a few times a second.
  const [, setTick] = useState(0);
  const tickTimer = useRef(0);
  const redraw = useCallback(() => {
    if (tickTimer.current) return;
    tickTimer.current = window.setTimeout(() => { tickTimer.current = 0; setTick((t) => t + 1); }, 150);
  }, []);
  const newGuest = useCallback((id: string, name: string, key: string): Guest => (
    { id, key, name, present: true, link: "connecting", messages: [], unread: 0, transfers: new Transfers(redraw) }
  ), [redraw]);

  const select = useCallback((id: string | null) => {
    selectedRef.current = id;
    setSelectedState(id);
    if (id) patch(id, (g) => ({ ...g, unread: 0 }));
  }, [patch]);

  const dropPeer = useCallback((id: string) => {
    peers.current.get(id)?.close();
    peers.current.delete(id);
    guest(id)?.transfers.detach();
  }, []);

  const makePeer = useCallback((id: string) => {
    const current = () => peers.current.get(id) === peer;
    const peer: PeerLink = new PeerLink({
      offerer: false,
      signal: (s: Signal) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "signal", to: id, data: s }));
      },
      onState: (link) => {
        patch(id, (g) => ({ ...g, link }));
        if (link === "connected" && current()) guest(id)?.transfers.attach(peer);
      },
      onChannel: (ch) => {
        const g = guest(id);
        if (g && current()) g.transfers.channel(ch);
        else ch.close();
      },
      onMessage: (m) => {
        if (guest(id)?.transfers.handle(m)) return;
        const ev = readChat(m, (r) => peer.send(r));
        if (!ev) return;
        patch(id, (g) => ({
          ...g,
          messages: applyChat(g.messages, ev),
          unread: ev.kind === "text" && selectedRef.current !== id ? g.unread + 1 : g.unread,
        }));
      },
    });
    peers.current.set(id, peer);
    return peer;
  }, [patch]);

  useEffect(() => {
    if (!room) return;
    let stopped = false, tries = 0, timer = 0;
    const connect = () => {
      const ws = roomSocket(room.id);
      wsRef.current = ws;
      ws.onopen = () => ws.send(JSON.stringify({ type: "host", token: room.token, name: deviceName() }));
      ws.onmessage = (e) => {
        let m: any;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === "welcome") {
          tries = 0;
          setStatus("open");
          setLocked(m.locked === true);
          const list: { id: string; name: string; key?: string }[] = Array.isArray(m.guests) ? m.guests : [];
          for (const id of [...peers.current.keys()]) if (!list.some((x) => x.id === id)) dropPeer(id);
          // After a reload this page has no connections left; ask each device to set one up again.
          for (const x of list) {
            if (peers.current.get(x.id)?.state !== "connected") ws.send(JSON.stringify({ type: "signal", to: x.id, data: { restart: true } }));
          }
          updateGuests((old) => {
            const next: Guest[] = [];
            for (const x of list) {
              const was = old.find((g) => g.id === x.id) ?? (x.key ? old.find((g) => g.key === x.key) : undefined);
              next.push(was ? { ...was, id: x.id, present: true } : newGuest(x.id, uniqueName([...old, ...next], x.name), x.key ?? ""));
            }
            // Devices that left while this page was away stay listed with what they had.
            for (const g of old) if (!next.some((n) => n.id === g.id || (g.key && n.key === g.key))) next.push({ ...g, present: false });
            return next;
          });
        } else if (m.type === "knock") {
          // The PIN is checked here, on the main device, not on the server.
          const ok = m.pin === room.pin;
          ws.send(JSON.stringify({ type: "admit", to: m.from, ok }));
          if (ok) {
            const key = typeof m.key === "string" ? m.key : "";
            const back = key ? guestsRef.current.find((g) => g.key === key) : undefined;
            if (back) {
              // A device coming back: same entry, same conversation, its paused transfers carry on.
              if (back.id !== m.from) dropPeer(back.id);
              const wasOpen = selectedRef.current === back.id;
              updateGuests((list) => list.map((g) => (g.key === key ? { ...g, id: m.from, present: true, link: "connecting" } : g)));
              if (wasOpen) select(m.from);
            } else {
              updateGuests((list) => {
                const rest = list.filter((x) => x.id !== m.from);
                return [...rest, newGuest(m.from, uniqueName(rest, String(m.name)), key)];
              });
            }
          } else {
            setNotice(`${m.name} typed a wrong PIN.`);
          }
        } else if (m.type === "signal" && m.data && typeof m.data === "object") {
          const data = m.data as Signal;
          // Each device starts its connection with an offer; a new offer replaces the old connection.
          if (data.sdp?.type === "offer") {
            dropPeer(m.from);
            patch(m.from, (g) => ({ ...g, link: "connecting" }));
            makePeer(m.from).handle(data);
          } else {
            peers.current.get(m.from)?.handle(data);
          }
        } else if (m.type === "left") {
          const g = guest(m.from);
          dropPeer(m.from);
          // A device with a key may come back (a dropped Wi-Fi, a reload); keep it listed until then.
          if (g?.key) {
            patch(m.from, (x) => ({ ...x, present: false }));
          } else {
            updateGuests((list) => list.filter((x) => x.id !== m.from));
            if (selectedRef.current === m.from) select(null);
          }
        } else if (m.type === "locked") {
          setLocked(true);
        }
      };
      ws.onclose = (e) => {
        if (stopped || wsRef.current !== ws) return;
        const final = closeMessage(e.code, e.reason);
        if (final) {
          writeSession(KEY, null);
          setEnded(final);
          setRoom(null);
          return;
        }
        setStatus("reconnecting");
        timer = window.setTimeout(connect, retryDelay(tries++));
      };
    };
    setStatus("connecting");
    connect();
    const all = peers.current;
    return () => {
      stopped = true;
      clearTimeout(timer);
      wsRef.current?.close();
      wsRef.current = null;
      for (const p of all.values()) p.close();
      all.clear();
      for (const g of guestsRef.current) g.transfers.end("The room closed");
    };
  }, [room, makePeer, patch, select, updateGuests, newGuest, dropPeer]);

  // A device that has left takes its conversation with it; pick another one to show.
  useEffect(() => {
    if (!selected && guests.length) select(guests[0].id);
  }, [selected, guests, select]);

  const start = useCallback(async () => {
    setStarting(true);
    setEnded(null);
    try {
      const saved = { ...(await createRoom()), pin: newPin() };
      writeSession(KEY, saved);
      updateGuests(() => []);
      setNotice(null);
      setLocked(false);
      select(null);
      setRoom(saved);
    } catch {
      setEnded("Could not start a room. Check the internet connection and try again.");
    } finally {
      setStarting(false);
    }
  }, [select, updateGuests]);

  const close = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "close" }));
    writeSession(KEY, null);
    // Half-received files are dropped, not left open.
    for (const g of guestsRef.current) g.transfers.end("The room closed");
    updateGuests(() => []);
    setNotice(null);
    select(null);
    setRoom(null);
  }, [select, updateGuests]);

  const sendText = useCallback((id: string, body: string) => {
    const peer = peers.current.get(id);
    const { wire, msg } = newText(body);
    if (!peer?.send(wire)) return false;
    patch(id, (g) => ({ ...g, messages: [...g.messages, msg] }));
    return true;
  }, [patch]);

  // Paused counts too: closing the page then would lose what's needed to carry on.
  const busy = guests.some((g) => g.transfers.batches.some((b) => b.state === "active" || b.state === "paused"));

  return {
    room, status, guests, selected, notice, locked, ended, starting, busy,
    start, close, select, sendText, dismissNotice: () => setNotice(null),
  };
}
