import { useState, type FormEvent, type ReactNode } from "react";
import { BLOCKED_HELP, Button, Card, DeviceTile, IconTile, LinkPill, Note, TabBar, shownOn } from "../ui";
import { Conversation } from "../Conversation";
import { FilesPanel } from "../Files";
import { SharedWaiting } from "../Shared";
import { useBusyGuard } from "../lib/guard";
import { useGuestRoom } from "./useGuestRoom";

type Section = "files" | "text";

export function GuestPage({ roomId }: { roomId: string }) {
  const g = useGuestRoom(roomId);
  const [tab, setTab] = useState<Section>("files");
  useBusyGuard(g.busy);

  if (g.phase === "ended") {
    return (
      <Centered>
        <Card>
          <div className="flex flex-col items-start gap-3">
            <IconTile name="x" tone="bg-bad-soft text-bad" size="size-12" />
            <h1 className="text-xl font-bold">{g.wasIn ? "Room closed" : "Can't join this room"}</h1>
            <p className="text-muted">{g.message}</p>
            <Button icon="arrow" onClick={() => { location.hash = ""; }}>Go to the start page</Button>
          </div>
        </Card>
      </Centered>
    );
  }

  if (g.phase === "in") {
    const host = g.hostName || "The main device";
    const offers = g.transfers.batches.filter((b) => b.state === "incoming").length;
    return (
      <>
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3 rounded-3xl bg-surface p-4 shadow-[var(--shadow-card)]">
            <DeviceTile name={host} size="size-12" />
            <div className="min-w-0 flex-1">
              <p className="text-xs text-muted">Joined</p>
              <p className="break-words font-semibold">{host}</p>
              <div className="mt-1"><LinkPill link={g.link} /></div>
            </div>
          </div>
          {g.hostAway ? (
            <Note tone="warn">The main device is away. This page will reconnect when it's back.</Note>
          ) : g.link === "blocked" ? (
            <div className="flex flex-col items-start gap-3">
              <Note tone="bad">{BLOCKED_HELP}</Note>
              <Button onClick={g.retry}>Try again</Button>
            </div>
          ) : g.reconnecting ? (
            <Note tone="warn">Can't reach the room right now. Trying again…</Note>
          ) : null}
        </div>

        <SharedWaiting
          targets={[{ id: "main", name: host, ready: g.link === "connected" && !g.transfers.mismatch, transfers: g.transfers, sendText: g.sendText }]}
          notReady=""
        />

        <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
          <div className={`${shownOn(tab === "files")} min-w-0 flex-col`}>
            <Card title="Files">
              <FilesPanel transfers={g.transfers} otherName={host} canSend={g.link === "connected"} />
            </Card>
          </div>
          <div className={`${shownOn(tab === "text")} min-w-0 flex-col`}>
            <Card title="Text and links">
              <Conversation messages={g.messages} canSend={g.link === "connected"} onSend={g.sendText} otherName={host} />
            </Card>
          </div>
        </div>

        <TabBar
          current={tab}
          onChange={setTab}
          tabs={[
            { id: "files", label: "Files", icon: "folder", badge: offers },
            { id: "text", label: "Text", icon: "chat" },
          ]}
        />
      </>
    );
  }

  return (
    <Centered>
      <Card>
        <div className="flex flex-col gap-4">
          <IconTile name="room" size="size-12" />
          <div>
            <h1 className="text-xl font-bold">Join a room</h1>
            {g.phase !== "waiting" && <p className="text-sm text-muted">Then send files and text to the main device.</p>}
          </div>
          {g.phase === "waiting" ? (
            <Note tone="warn">The main device is away. This page will join as soon as it's back.</Note>
          ) : (
            <PinForm busy={g.phase === "checking"} triesLeft={g.triesLeft} onSubmit={g.submitPin} />
          )}
          {g.reconnecting && <Note tone="warn">Can't reach the room right now. Trying again…</Note>}
        </div>
      </Card>
      <div className="mt-4">
        <SharedWaiting targets={[]} notReady="Join with the PIN first; then you can send these to the main device." />
      </div>
    </Centered>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-md pt-2 sm:pt-10">{children}</div>;
}

function PinForm({ busy, triesLeft, onSubmit }: { busy: boolean; triesLeft: number | null; onSubmit: (pin: string) => void }) {
  const [pin, setPin] = useState("");
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (pin.length === 6) onSubmit(pin);
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <label htmlFor="pin" className="block font-medium">Type the 6-digit PIN shown on the main device.</label>
      <input
        id="pin"
        value={pin}
        onChange={(e) => setPin(e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode="numeric"
        autoComplete="one-time-code"
        autoFocus
        disabled={busy}
        aria-invalid={triesLeft !== null}
        placeholder="••••••"
        className="min-h-14 w-full min-w-0 rounded-2xl bg-sunken px-4 text-center font-mono text-3xl font-bold tracking-[0.4em] text-ink placeholder:text-line focus:bg-accent-soft"
      />
      <Button kind="primary" type="submit" className="min-h-12" disabled={busy || pin.length !== 6}>{busy ? "Checking…" : "Join"}</Button>
      {triesLeft !== null && !busy && (
        <Note tone="bad">That PIN is wrong. {triesLeft} {triesLeft === 1 ? "try" : "tries"} left.</Note>
      )}
    </form>
  );
}
