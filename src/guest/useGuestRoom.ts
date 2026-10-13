import { useCallback, useEffect, useRef, useState } from "react";
import { closeMessage, readSession, retryDelay, roomSocket, writeSession } from "../lib/room";
import { deviceName } from "../lib/device";

export type GuestPhase = "pin" | "checking" | "waiting" | "in" | "ended";

// The PIN that worked, and the room's pass for this device, are kept for this tab,
// so a reload or a dropped Wi-Fi joins again without asking.
const keyFor = (id: string) => "lanet.join." + id;
type Saved = { pin: string; pass: string };

export function useGuestRoom(roomId: string) {
  const saved = readSession<Saved>(keyFor(roomId));
  const pinRef = useRef<string | null>(typeof saved?.pin === "string" ? saved.pin : null);
  const passRef = useRef<string | null>(typeof saved?.pass === "string" ? saved.pass : null);
  const [phase, setPhaseState] = useState<GuestPhase>(pinRef.current ? "checking" : "pin");
  // Socket handlers read the phase from here, as they outlive the render that made them.
  const phaseRef = useRef(phase);
  const setPhase = useCallback((p: GuestPhase) => { phaseRef.current = p; setPhaseState(p); }, []);
  const [triesLeft, setTriesLeft] = useState<number | null>(null);
  const [hostName, setHostName] = useState("");
  const [hostAway, setHostAway] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [message, setMessage] = useState("");
  const [wasIn, setWasIn] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);

  const join = useCallback(() => {
    const ws = wsRef.current;
    if (pinRef.current && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "join", pin: pinRef.current, pass: passRef.current ?? undefined, name: deviceName() }));
    }
  }, []);

  useEffect(() => {
    let stopped = false, tries = 0, timer = 0;
    // Connecting before the PIN is typed tells us at once if the room has already closed.
    const connect = () => {
      const ws = roomSocket(roomId);
      wsRef.current = ws;
      ws.onopen = () => {
        tries = 0;
        setReconnecting(false);
        join();
      };
      ws.onmessage = (e) => {
        let m: any;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === "admitted") {
          passRef.current = typeof m.pass === "string" ? m.pass : null;
          writeSession(keyFor(roomId), { pin: pinRef.current, pass: passRef.current });
          setHostName(String(m.host ?? ""));
          setHostAway(false);
          setPhase("in");
        } else if (m.type === "wrongPin") {
          pinRef.current = null;
          passRef.current = null;
          writeSession(keyFor(roomId), null);
          setTriesLeft(typeof m.left === "number" ? m.left : null);
          setPhase("pin");
        } else if (m.type === "hostAway") {
          setHostAway(true);
          if (phaseRef.current === "checking") setPhase("waiting");
        } else if (m.type === "hostBack") {
          setHostAway(false);
          if (phaseRef.current === "waiting") {
            setPhase("checking");
            join();
          }
        }
      };
      ws.onclose = (e) => {
        if (stopped || wsRef.current !== ws) return;
        const final = closeMessage(e.code, e.reason);
        if (final) {
          writeSession(keyFor(roomId), null);
          setWasIn(phaseRef.current === "in");
          setMessage(final);
          setPhase("ended");
          return;
        }
        setReconnecting(true);
        // A device that was in knocks again with its PIN when the connection is back.
        if (phaseRef.current === "in" || phaseRef.current === "waiting") setPhase("checking");
        timer = window.setTimeout(connect, retryDelay(tries++));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [roomId, join, setPhase]);

  const submitPin = useCallback((pin: string) => {
    pinRef.current = pin;
    setPhase("checking");
    join();
  }, [join, setPhase]);

  return { phase, triesLeft, hostName, hostAway, reconnecting, message, wasIn, submitPin };
}
