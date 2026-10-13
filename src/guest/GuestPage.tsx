import { useState, type FormEvent } from "react";
import { Button, Card, Note } from "../ui";
import { useGuestRoom } from "./useGuestRoom";

export function GuestPage({ roomId }: { roomId: string }) {
  const g = useGuestRoom(roomId);

  if (g.phase === "ended") {
    return (
      <Card title={g.wasIn ? "Room closed" : "Can't join this room"}>
        <p className="mb-4 text-muted">{g.message}</p>
        <Button onClick={() => { location.hash = ""; }}>Go to the start page</Button>
      </Card>
    );
  }

  if (g.phase === "in") {
    return (
      <Card title="You're in">
        <p className="mb-3">Connected to <b>{g.hostName}</b>.</p>
        {g.hostAway && <div className="mb-3"><Note tone="warn">The main device is away. This page will reconnect when it's back.</Note></div>}
        {g.reconnecting && <div className="mb-3"><Note tone="warn">Reconnecting…</Note></div>}
        <p className="text-sm text-muted">Sending files and text comes in the next update.</p>
      </Card>
    );
  }

  return (
    <Card title="Join a room">
      {g.phase === "waiting" ? (
        <Note tone="warn">The main device is away. This page will join as soon as it's back.</Note>
      ) : (
        <PinForm busy={g.phase === "checking"} triesLeft={g.triesLeft} onSubmit={g.submitPin} />
      )}
      {g.reconnecting && <div className="mt-3"><Note tone="warn">Can't reach the room right now. Trying again…</Note></div>}
    </Card>
  );
}

function PinForm({ busy, triesLeft, onSubmit }: { busy: boolean; triesLeft: number | null; onSubmit: (pin: string) => void }) {
  const [pin, setPin] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pin.length === 6) onSubmit(pin);
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <label htmlFor="pin" className="block text-muted">Type the 6-digit PIN shown on the main device.</label>
      <div className="flex flex-wrap gap-2">
        <input
          id="pin"
          value={pin}
          onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
          inputMode="numeric"
          autoComplete="one-time-code"
          autoFocus
          disabled={busy}
          aria-invalid={triesLeft !== null}
          className="min-h-11 w-44 min-w-0 rounded-xl border border-line bg-surface px-3 font-mono text-2xl tracking-[0.3em] text-ink"
        />
        <Button kind="primary" type="submit" disabled={busy || pin.length !== 6}>{busy ? "Checking…" : "Join"}</Button>
      </div>
      {triesLeft !== null && !busy && (
        <Note tone="bad">That PIN is wrong. {triesLeft} {triesLeft === 1 ? "try" : "tries"} left.</Note>
      )}
    </form>
  );
}
