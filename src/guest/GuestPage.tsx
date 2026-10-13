import { useState, type FormEvent } from "react";
import { BLOCKED_HELP, Button, Card, LinkPill, Note } from "../ui";
import { Conversation } from "../Conversation";
import { FilesPanel } from "../Files";
import { useBusyGuard } from "../lib/guard";
import { useGuestRoom } from "./useGuestRoom";

export function GuestPage({ roomId }: { roomId: string }) {
  const g = useGuestRoom(roomId);
  useBusyGuard(g.busy);

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
      <>
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="min-w-0">Joined <b className="break-words">{g.hostName}</b></p>
            <LinkPill link={g.link} />
          </div>
          {g.hostAway ? (
            <div className="mt-3"><Note tone="warn">The main device is away. This page will reconnect when it's back.</Note></div>
          ) : g.link === "blocked" ? (
            <div className="mt-3 space-y-3">
              <Note tone="bad">{BLOCKED_HELP}</Note>
              <Button onClick={g.retry}>Try again</Button>
            </div>
          ) : g.reconnecting ? (
            <div className="mt-3"><Note tone="warn">Can't reach the room right now. Trying again…</Note></div>
          ) : null}
        </Card>
        <Card title="Files">
          <FilesPanel transfers={g.transfers} otherName={g.hostName || "The main device"} canSend={g.link === "connected"} />
        </Card>
        <Card title={`Text with ${g.hostName || "the main device"}`}>
          <Conversation messages={g.messages} canSend={g.link === "connected"} onSend={g.sendText} otherName={g.hostName} />
        </Card>
      </>
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
