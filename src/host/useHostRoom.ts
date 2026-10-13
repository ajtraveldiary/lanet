import { useCallback, useEffect, useRef, useState } from "react";
import { closeMessage, createRoom, newPin, readSession, retryDelay, roomSocket, writeSession } from "../lib/room";
import { deviceName } from "../lib/device";
import { PeerLink, type LinkState, type Signal } from "../lib/peer";
import { applyChat, newText, readChat, type ChatMsg } from "../lib/chat";

export type Guest = { id: string; name: string; link: LinkState; messages: ChatMsg[]; unread: number };
type Saved = { id: string; token: string; pin: string };

// Kept for this tab only, so a reload goes back into the same room with the same PIN.
const KEY = "lanet.host";

function loadSaved(): Saved | null {
  const s = readSession<Saved>(KEY);
  return s && typeof s.id === "string" && typeof s.token === "string" && /^\d{6}$/.test(String(s.pin)) ? s : null;
}

const freshGuest = (id: string, name: string): Guest => ({ id, name, link: "connecting", messages: [], unread: 0 });

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
  // Socket and connection handlers outlive renders, so they read the open conversation from here.
  const selectedRef = useRef<string | null>(null);

  const patch = useCallback((id: string, fn: (g: Guest) => Guest) => {
    setGuests((list) => list.map((g) => (g.id === id ? fn(g) : g)));
  }, []);

  const select = useCallback((id: string | null) => {
    selectedRef.current = id;
    setSelectedState(id);
    if (id) patch(id, (g) => ({ ...g, unread: 0 }));
  }, [patch]);

  const dropPeer = (id: string) => {
    peers.current.get(id)?.close();
    peers.current.delete(id);
  };

  const makePeer = useCallback((id: string) => {
    const peer: PeerLink = new PeerLink({
      offerer: false,
      signal: (s: Signal) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "signal", to: id, data: s }));
      },
      onState: (link) => patch(id, (g) => ({ ...g, link })),
      onMessage: (m) => {
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
          const list: { id: string; name: string }[] = Array.isArray(m.guests) ? m.guests : [];
          for (const id of [...peers.current.keys()]) if (!list.some((x) => x.id === id)) dropPeer(id);
          // After a reload this page has no connections left; ask each device to set one up again.
          for (const x of list) {
            if (peers.current.get(x.id)?.state !== "connected") ws.send(JSON.stringify({ type: "signal", to: x.id, data: { restart: true } }));
          }
          setGuests((old) => list.reduce<Guest[]>((acc, x) => {
            acc.push(old.find((g) => g.id === x.id) ?? freshGuest(x.id, uniqueName(acc, x.name)));
            return acc;
          }, []));
        } else if (m.type === "knock") {
          // The PIN is checked here, on the main device, not on the server.
          const ok = m.pin === room.pin;
          ws.send(JSON.stringify({ type: "admit", to: m.from, ok }));
          if (ok) {
            setGuests((g) => {
              const rest = g.filter((x) => x.id !== m.from);
              return [...rest, freshGuest(m.from, uniqueName(rest, String(m.name)))];
            });
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
          dropPeer(m.from);
          setGuests((g) => g.filter((x) => x.id !== m.from));
          if (selectedRef.current === m.from) select(null);
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
    };
  }, [room, makePeer, patch, select]);

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
      setGuests([]);
      setNotice(null);
      setLocked(false);
      select(null);
      setRoom(saved);
    } catch {
      setEnded("Could not start a room. Check the internet connection and try again.");
    } finally {
      setStarting(false);
    }
  }, [select]);

  const close = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "close" }));
    writeSession(KEY, null);
    setGuests([]);
    setNotice(null);
    select(null);
    setRoom(null);
  }, [select]);

  const sendText = useCallback((id: string, body: string) => {
    const peer = peers.current.get(id);
    const { wire, msg } = newText(body);
    if (!peer?.send(wire)) return false;
    patch(id, (g) => ({ ...g, messages: [...g.messages, msg] }));
    return true;
  }, [patch]);

  return {
    room, status, guests, selected, notice, locked, ended, starting,
    start, close, select, sendText, dismissNotice: () => setNotice(null),
  };
}
