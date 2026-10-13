import { useState } from "react";
import { Button, Card, Note } from "../ui";
import { Qr } from "../Qr";
import { roomLink } from "../lib/room";
import { useHostRoom, type Guest } from "./useHostRoom";

export function HostPage() {
  const host = useHostRoom();
  if (!host.room) return <Home starting={host.starting} ended={host.ended} onStart={host.start} />;
  return <Room {...host} room={host.room} />;
}

function Home({ starting, ended, onStart }: { starting: boolean; ended: string | null; onStart: () => void }) {
  return (
    <>
      <div className="pt-4 sm:pt-10">
        <h1 className="mb-2 text-2xl font-semibold sm:text-3xl">Share files on your Wi-Fi</h1>
        <p className="max-w-prose text-muted">
          Start a room on this device. Other devices on the same Wi-Fi join with a link and a PIN, then send files,
          folders and text straight to this device. Nothing goes through the internet.
        </p>
      </div>
      {ended && <Note tone="warn">{ended}</Note>}
      <div>
        <Button kind="primary" className="w-full text-lg sm:w-auto sm:px-8" disabled={starting} onClick={onStart}>
          {starting ? "Starting…" : "Start sharing"}
        </Button>
      </div>
      <Card title="How it works">
        <ol className="list-decimal space-y-1 pl-5 text-muted">
          <li>Tap <b className="text-ink">Start sharing</b> on this device.</li>
          <li>On the other device, scan the QR code or open the link, then type the PIN.</li>
          <li>Send files, folders or text. They go straight from device to device.</li>
        </ol>
      </Card>
    </>
  );
}

type RoomProps = ReturnType<typeof useHostRoom> & { room: NonNullable<ReturnType<typeof useHostRoom>["room"]> };

function Room({ room, status, guests, notice, locked, close, dismissNotice }: RoomProps) {
  const link = roomLink(room.id);
  const onLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
        <h1 className="text-2xl font-semibold">Your room</h1>
        <StatusPill status={status} />
      </div>

      <Card>
        <div className="grid gap-5 sm:grid-cols-[minmax(0,13rem)_1fr] sm:items-start">
          <div className="mx-auto w-full max-w-52 sm:max-w-none">
            <Qr text={link} label="QR code with the room link" />
          </div>
          <div className="min-w-0 space-y-4">
            <div>
              <p className="mb-1 text-sm text-muted">On the other device, scan the QR code or open this link:</p>
              <p className="select-all break-all font-mono text-sm">{link}</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <CopyButton text={link} />
                {"share" in navigator && (
                  <Button onClick={() => navigator.share({ title: "Lanet room", url: link }).catch(() => {})}>Share link</Button>
                )}
              </div>
            </div>
            <div>
              <p className="mb-1 text-sm text-muted">Then type this PIN:</p>
              <p className="font-mono text-4xl font-semibold tracking-widest" aria-label={`PIN ${room.pin.split("").join(" ")}`}>
                {room.pin.slice(0, 3)}&nbsp;{room.pin.slice(3)}
              </p>
            </div>
          </div>
        </div>
        {onLocalhost && (
          <div className="mt-4">
            <Note tone="warn">
              This page is open as “{location.host}”, so the link won't work on other devices. Open this page using
              this computer's Wi-Fi address instead (it starts with 192.168. or 10.).
            </Note>
          </div>
        )}
      </Card>

      <Card title={`Devices${guests.length ? ` (${guests.length})` : ""}`}>
        {locked && <div className="mb-3"><Note tone="bad">10 wrong PINs were typed, so no new devices can join. Devices already here stay. Close this room and start a new one if more need to join.</Note></div>}
        {notice && (
          <div className="mb-3 flex items-start gap-2">
            <div className="flex-1"><Note tone="warn">{notice}</Note></div>
            <Button className="min-w-11 px-2" aria-label="Dismiss" onClick={dismissNotice}>✕</Button>
          </div>
        )}
        {guests.length ? <GuestList guests={guests} /> : (
          <p className="text-muted">No devices yet. They appear here once they type the PIN.</p>
        )}
      </Card>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted">Keep this page open. The room closes 2 minutes after it's closed.</p>
        <Button onClick={close}>Close room</Button>
      </div>
    </>
  );
}

function GuestList({ guests }: { guests: Guest[] }) {
  return (
    <ul className="divide-y divide-line">
      {guests.map((g) => (
        <li key={g.id} className="flex items-center gap-3 py-2">
          <span className="size-2.5 shrink-0 rounded-full bg-accent" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{g.name}</span>
          <span className="text-sm text-muted">Joined</span>
        </li>
      ))}
    </ul>
  );
}

function StatusPill({ status }: { status: "connecting" | "open" | "reconnecting" }) {
  const text = status === "open" ? "Room open" : status === "connecting" ? "Opening…" : "Reconnecting…";
  const look = status === "open" ? "bg-accent-soft text-ink" : "bg-warn-soft text-on-warn";
  return <span role="status" className={`rounded-full px-3 py-1 text-sm ${look}`}>{text}</span>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard on plain http pages; the link is selectable instead.
      window.prompt("Copy this link:", text);
    }
  };
  return <Button onClick={copy}>{copied ? "Copied ✓" : "Copy link"}</Button>;
}
