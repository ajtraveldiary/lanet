import { useCallback, useEffect, useRef, useState } from "react";
import { closeMessage, createRoom, newPin, readSession, retryDelay, roomSocket, writeSession } from "../lib/room";
import { deviceName } from "../lib/device";

export type Guest = { id: string; name: string };
type Saved = { id: string; token: string; pin: string };

// Kept for this tab only, so a reload goes back into the same room with the same PIN.
const KEY = "lanet.host";

function loadSaved(): Saved | null {
  const s = readSession<Saved>(KEY);
  return s && typeof s.id === "string" && typeof s.token === "string" && /^\d{6}$/.test(String(s.pin)) ? s : null;
}

export function useHostRoom() {
  const [room, setRoom] = useState<Saved | null>(loadSaved);
  const [status, setStatus] = useState<"connecting" | "open" | "reconnecting">("connecting");
  const [guests, setGuests] = useState<Guest[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [ended, setEnded] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

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
          setGuests(Array.isArray(m.guests) ? m.guests : []);
          setLocked(m.locked === true);
        } else if (m.type === "knock") {
          // The PIN is checked here, on the main device, not on the server.
          const ok = m.pin === room.pin;
          ws.send(JSON.stringify({ type: "admit", to: m.from, ok }));
          if (ok) setGuests((g) => [...g.filter((x) => x.id !== m.from), { id: m.from, name: m.name }]);
          else setNotice(`${m.name} typed a wrong PIN.`);
        } else if (m.type === "left") {
          setGuests((g) => g.filter((x) => x.id !== m.from));
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
    return () => {
      stopped = true;
      clearTimeout(timer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [room]);

  const start = useCallback(async () => {
    setStarting(true);
    setEnded(null);
    try {
      const saved = { ...(await createRoom()), pin: newPin() };
      writeSession(KEY, saved);
      setGuests([]);
      setNotice(null);
      setLocked(false);
      setRoom(saved);
    } catch {
      setEnded("Could not start a room. Check the internet connection and try again.");
    } finally {
      setStarting(false);
    }
  }, []);

  const close = useCallback(() => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "close" }));
    writeSession(KEY, null);
    setGuests([]);
    setNotice(null);
    setRoom(null);
  }, []);

  return { room, status, guests, notice, locked, ended, starting, start, close, dismissNotice: () => setNotice(null) };
}
