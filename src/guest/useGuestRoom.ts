import { useCallback, useEffect, useRef, useState } from "react";
import { closeMessage, readSession, retryDelay, roomSocket, writeSession } from "../lib/room";
import { deviceName } from "../lib/device";
import { PeerLink, type LinkState, type Signal } from "../lib/peer";
import { applyChat, newText, readChat, type ChatMsg } from "../lib/chat";
import { randomKey } from "../lib/peer";
import { Transfers } from "../lib/transfers";

export type GuestPhase = "pin" | "checking" | "waiting" | "in" | "ended";

// The PIN that worked, the room's pass for this device, and the device's own key are kept for this tab,
// so a reload or a dropped Wi-Fi joins again without asking, and the main device knows it's the same device.
const keyFor = (id: string) => "lanet.join." + id;
type Saved = { pin?: string; pass?: string; key?: string };

// A direct connection that drops is set up again after this long, if it hasn't come back by itself.
const RESTART_AFTER = 5000;

export function useGuestRoom(roomId: string) {
  const saved = readSession<Saved>(keyFor(roomId));
  const pinRef = useRef<string | null>(typeof saved?.pin === "string" ? saved.pin : null);
  const passRef = useRef<string | null>(typeof saved?.pass === "string" ? saved.pass : null);
  const deviceKey = useRef(typeof saved?.key === "string" && saved.key ? saved.key : randomKey());
  const [phase, setPhaseState] = useState<GuestPhase>(pinRef.current ? "checking" : "pin");
  // Socket and connection handlers outlive renders, so they read these from refs.
  const phaseRef = useRef(phase);
  const setPhase = useCallback((p: GuestPhase) => { phaseRef.current = p; setPhaseState(p); }, []);
  const [hostAway, setHostAwayState] = useState(false);
  const hostAwayRef = useRef(false);
  const setHostAway = useCallback((v: boolean) => { hostAwayRef.current = v; setHostAwayState(v); }, []);
  const [triesLeft, setTriesLeft] = useState<number | null>(null);
  const [hostName, setHostName] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const [message, setMessage] = useState("");
  const [wasIn, setWasIn] = useState(false);
  const [link, setLink] = useState<LinkState>("connecting");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const peerRef = useRef<PeerLink | null>(null);
  // True from sending the PIN until the room answers; a main device that comes back gets it again.
  const joinPending = useRef(false);
  const restartTimer = useRef(0);

  // File progress changes many times a second; the page is redrawn at most a few times a second.
  const [, setTick] = useState(0);
  const tickTimer = useRef(0);
  const [transfers] = useState(() => new Transfers(() => {
    if (tickTimer.current) return;
    tickTimer.current = window.setTimeout(() => { tickTimer.current = 0; setTick((t) => t + 1); }, 150);
  }));

  const join = useCallback(() => {
    const ws = wsRef.current;
    if (pinRef.current && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "join", pin: pinRef.current, pass: passRef.current ?? undefined, key: deviceKey.current, name: deviceName() }));
      joinPending.current = true;
    }
  }, []);

  // Two extra connections to the main device, used only to spread big files for speed.
  const lanesRef = useRef<(PeerLink | null)[]>([null, null, null]);
  const laneTimers = useRef([0, 0, 0]);

  const closeLanes = useCallback(() => {
    for (const k of [1, 2]) {
      clearTimeout(laneTimers.current[k]);
      lanesRef.current[k]?.close();
      lanesRef.current[k] = null;
      transfers.setLane(k, null);
    }
  }, [transfers]);

  const startLane = useCallback((k: number) => {
    clearTimeout(laneTimers.current[k]);
    lanesRef.current[k]?.close();
    transfers.setLane(k, null);
    const lane: PeerLink = new PeerLink({
      offerer: true,
      signal: (s: Signal) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "signal", data: { ...s, lane: k } }));
      },
      onState: (s) => {
        if (lanesRef.current[k] !== lane) return;
        transfers.setLane(k, s === "connected" ? lane : null);
        // One that drops is set up again while the main connection is fine; files just use fewer meanwhile.
        if (s === "reconnecting") {
          laneTimers.current[k] = window.setTimeout(() => {
            if (lanesRef.current[k] === lane && peerRef.current?.state === "connected") startLane(k);
          }, RESTART_AFTER);
        }
      },
      onChannel: (ch) => {
        if (lanesRef.current[k] === lane) transfers.channel(ch);
        else ch.close();
      },
      onMessage: () => {},
    });
    lanesRef.current[k] = lane;
  }, [transfers]);

  const startPeer = useCallback(() => {
    clearTimeout(restartTimer.current);
    peerRef.current?.close();
    closeLanes();
    transfers.detach();
    setLink("connecting");
    const peer: PeerLink = new PeerLink({
      offerer: true,
      signal: (s: Signal) => {
        const ws = wsRef.current;
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "signal", data: s }));
      },
      onState: (s) => {
        setLink(s);
        if (s === "connected" && peerRef.current === peer) {
          transfers.attach(peer);
          startLane(1);
          startLane(2);
        }
        clearTimeout(restartTimer.current);
        if (s === "reconnecting") {
          restartTimer.current = window.setTimeout(() => {
            // While the main device is away, it asks for a new connection itself when it's back.
            if (peerRef.current === peer && peer.state !== "connected" && !hostAwayRef.current) startPeer();
          }, RESTART_AFTER);
        }
      },
      onChannel: (ch) => {
        if (peerRef.current === peer) transfers.channel(ch);
        else ch.close();
      },
      onMessage: (m) => {
        if (transfers.handle(m)) return;
        const ev = readChat(m, (r) => peer.send(r));
        if (ev) setMessages((list) => applyChat(list, ev));
      },
    });
    peerRef.current = peer;
  }, [transfers, closeLanes, startLane]);

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
          joinPending.current = false;
          passRef.current = typeof m.pass === "string" ? m.pass : null;
          writeSession(keyFor(roomId), { pin: pinRef.current, pass: passRef.current, key: deviceKey.current });
          setHostName(String(m.host ?? ""));
          setHostAway(false);
          setPhase("in");
          // The room gives this device a new id on every join, so the main device needs a new connection too.
          startPeer();
        } else if (m.type === "wrongPin") {
          joinPending.current = false;
          pinRef.current = null;
          passRef.current = null;
          writeSession(keyFor(roomId), { key: deviceKey.current });
          setTriesLeft(typeof m.left === "number" ? m.left : null);
          setPhase("pin");
        } else if (m.type === "signal" && m.data && typeof m.data === "object") {
          const lane = Number(m.data.lane) || 0;
          if (lane === 1 || lane === 2) lanesRef.current[lane]?.handle(m.data as Signal);
          else if (m.data.restart) startPeer();
          else peerRef.current?.handle(m.data as Signal);
        } else if (m.type === "hostAway") {
          setHostAway(true);
          if (phaseRef.current === "checking") setPhase("waiting");
        } else if (m.type === "hostBack") {
          setHostAway(false);
          if (joinPending.current) {
            if (phaseRef.current === "waiting") setPhase("checking");
            join();
          }
        }
      };
      ws.onclose = (e) => {
        if (stopped || wsRef.current !== ws) return;
        const final = closeMessage(e.code, e.reason);
        if (final) {
          writeSession(keyFor(roomId), null);
          peerRef.current?.close();
          closeLanes();
          transfers.end("The room closed");
          setWasIn(phaseRef.current === "in");
          setMessage(final);
          setPhase("ended");
          return;
        }
        // The direct connection may well still be up; the page knocks again with its PIN once the room is back.
        setReconnecting(true);
        if (phaseRef.current === "waiting") setPhase("checking");
        timer = window.setTimeout(connect, retryDelay(tries++));
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(restartTimer.current);
      wsRef.current?.close();
      wsRef.current = null;
      peerRef.current?.close();
      peerRef.current = null;
      closeLanes();
    };
  }, [roomId, join, setPhase, setHostAway, startPeer, transfers, closeLanes]);

  const submitPin = useCallback((pin: string) => {
    pinRef.current = pin;
    setPhase("checking");
    join();
  }, [join, setPhase]);

  const sendText = useCallback((body: string) => {
    const { wire, msg } = newText(body);
    if (!peerRef.current?.send(wire)) return false;
    setMessages((list) => [...list, msg]);
    return true;
  }, []);

  // Paused counts too: closing the page then would lose what's needed to carry on.
  const busy = transfers.batches.some((b) => b.state === "active" || b.state === "paused");

  return { phase, triesLeft, hostName, hostAway, reconnecting, message, wasIn, link, messages, transfers, busy, submitPin, sendText, retry: startPeer };
}
