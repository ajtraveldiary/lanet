import { useState } from "react";
import { BLOCKED_HELP, Button, Card, DeviceTile, IconTile, LinkPill, Note, TabBar, shownOn } from "../ui";
import { Icon } from "../icons";
import { Qr } from "../Qr";
import { Conversation } from "../Conversation";
import { FilesPanel } from "../Files";
import { SharedWaiting, type Target } from "../Shared";
import { roomLink } from "../lib/room";
import { deviceName } from "../lib/device";
import { useBusyGuard } from "../lib/guard";
import { closeHint, hintClosed, installed } from "../lib/install";
import { isIOS } from "../lib/files";
import { useHostRoom, type Guest } from "./useHostRoom";

export function HostPage() {
  const host = useHostRoom();
  useBusyGuard(host.busy);
  if (!host.room) return <Home starting={host.starting} ended={host.ended} onStart={host.start} />;
  return <Room {...host} room={host.room} />;
}

const STEPS = [
  ["Start", "Tap Start sharing on this device."],
  ["Join", "On the other device, scan the QR code or open the link, then type the PIN."],
  ["Send", "Send files, folders or text. They go straight from device to device."],
] as const;

function Home({ starting, ended, onStart }: { starting: boolean; ended: string | null; onStart: () => void }) {
  const me = deviceName();
  return (
    <>
    <SharedWaiting targets={[]} notReady="Tap Start sharing and let a device join with the PIN; then you can send these to it." />
    <div className="grid gap-4 pt-2 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] lg:items-start lg:pt-8">
      <section className="flex flex-col gap-5 rounded-[2rem] bg-surface p-5 shadow-[var(--shadow-card)] sm:p-8">
        <span className="inline-flex w-fit items-center gap-2 rounded-full bg-teal-soft px-3 py-1 text-xs font-semibold text-teal">
          <span className="size-1.5 rounded-full bg-current" aria-hidden />
          Same Wi-Fi · straight from device to device
        </span>
        <div>
          <h1 className="mb-2 text-3xl font-bold tracking-tight sm:text-4xl">Share files on your Wi-Fi</h1>
          <p className="max-w-prose text-muted">
            Start a room on this device. Other devices on the same Wi-Fi join with a link and a PIN, then send files,
            folders and text straight to this device. Nothing goes through the internet.
          </p>
        </div>
        {ended && <Note tone="warn">{ended}</Note>}
        <div className="flex flex-col gap-3 rounded-3xl bg-sunken p-3 sm:flex-row sm:items-center">
          <div className="flex min-w-0 flex-1 items-center gap-3 px-1">
            <DeviceTile name={me} />
            <div className="min-w-0">
              <p className="text-xs text-muted">This device</p>
              <p className="break-words font-semibold">{me}</p>
            </div>
          </div>
          <Button kind="primary" icon="send" className="min-h-12 px-6 text-base" disabled={starting} onClick={onStart}>
            {starting ? "Starting…" : "Start sharing"}
          </Button>
        </div>
      </section>

      <section aria-labelledby="how" className="flex flex-col gap-3">
        <IosHint />
        <h2 id="how" className="px-1 text-base font-semibold">How it works</h2>
        <ol className="flex flex-col gap-3">
          {STEPS.map(([title, text], i) => (
            <li key={title} className="flex items-start gap-3 rounded-3xl bg-surface p-4 shadow-[var(--shadow-card)]">
              <span className="inline-flex size-10 shrink-0 items-center justify-center rounded-2xl bg-accent-soft font-bold text-accent">{i + 1}</span>
              <div>
                <p className="font-semibold">{title}</p>
                <p className="text-sm text-muted">{text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
    </>
  );
}

// iPhones and iPads can't be asked to install, so they get a short how-to, until closed.
function IosHint() {
  const [shown, setShown] = useState(() => isIOS() && !installed() && !hintClosed());
  if (!shown) return null;
  return (
    <div role="note" className="flex items-start gap-3 rounded-3xl bg-accent-soft p-4">
      <IconTile name="plusSquare" tone="bg-surface text-accent" />
      <p className="min-w-0 flex-1 text-sm">
        <b>Add Lanet to your Home Screen</b> to open it like an app: tap{" "}
        <Icon name="iosShare" className="inline size-4 align-[-3px] text-accent" /> <b>Share</b>, then{" "}
        <b>Add to Home Screen</b>.
      </p>
      <Button className="min-w-11 px-2" aria-label="Close" onClick={() => { closeHint(); setShown(false); }}><Icon name="x" /></Button>
    </div>
  );
}

type RoomProps = ReturnType<typeof useHostRoom> & { room: NonNullable<ReturnType<typeof useHostRoom>["room"]> };
type Section = "room" | "files" | "text";

function Room({ room, status, guests, selected, notice, locked, close, select, sendText, dismissNotice }: RoomProps) {
  const [tab, setTab] = useState<Section>("room");
  const open = guests.find((g) => g.id === selected) ?? null;
  const offers = guests.reduce((n, g) => n + g.transfers.batches.filter((b) => b.state === "incoming").length, 0);
  const unread = guests.reduce((n, g) => n + g.unread, 0);
  const canSend = !!open && open.present && open.link === "connected";
  // Picking a device on a phone goes straight to its files.
  const pick = (id: string) => { select(id); setTab("files"); };
  const targets: Target[] = guests.filter((g) => g.present).map((g) => ({
    id: g.id, name: g.name, ready: g.link === "connected" && !g.transfers.mismatch, transfers: g.transfers,
    sendText: (body: string) => sendText(g.id, body),
  }));

  return (
    <>
      <SharedWaiting targets={targets} preferred={selected} notReady="When a device joins with the PIN, you can send these to it." />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,24rem)_minmax(0,1fr)] lg:items-start">
        <div className={`${shownOn(tab === "room")} min-w-0 flex-col gap-4`}>
          <RoomCard room={room} status={status} />
          <Card title={`Devices${guests.length ? ` (${guests.length})` : ""}`}>
            {locked && <div className="mb-3"><Note tone="bad">10 wrong PINs were typed, so no new devices can join. Devices already here stay. Close this room and start a new one if more need to join.</Note></div>}
            {notice && (
              <div className="mb-3 flex items-start gap-2">
                <div className="flex-1"><Note tone="warn">{notice}</Note></div>
                <Button className="min-w-11 px-2" aria-label="Dismiss" onClick={dismissNotice}><Icon name="x" /></Button>
              </div>
            )}
            {guests.length ? <GuestList guests={guests} selected={selected} onSelect={pick} /> : (
              <p className="text-sm text-muted">No devices yet. They appear here once they type the PIN.</p>
            )}
          </Card>
          <div className="flex flex-col gap-3 px-1 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted">Keep this page open. The room closes 2 minutes after it's closed.</p>
            <Button icon="x" onClick={close}>Close room</Button>
          </div>
        </div>

        <div className={`${tab === "room" ? "hidden lg:flex" : "flex"} min-w-0 flex-col gap-4`}>
          {open ? (
            <>
              <DeviceHeader guests={guests} open={open} onSelect={select} />
              <div className={`${shownOn(tab === "files")} min-w-0 flex-col`}>
                <Card title="Files">
                  <FilesPanel key={open.key || open.id} transfers={open.transfers} otherName={open.name} canSend={canSend} />
                </Card>
              </div>
              <div className={`${shownOn(tab === "text")} min-w-0 flex-col`}>
                <Card title="Text and links">
                  <Conversation
                    key={open.key || open.id}
                    messages={open.messages}
                    canSend={canSend}
                    onSend={(body) => sendText(open.id, body)}
                    otherName={open.name}
                  />
                </Card>
              </div>
            </>
          ) : (
            <Card>
              <div className="flex flex-col items-center gap-3 py-8 text-center">
                <IconTile name="room" size="size-14" />
                <p className="font-semibold">No devices yet</p>
                <p className="max-w-sm text-sm text-muted">When a device joins with the PIN, its files and messages show here.</p>
              </div>
            </Card>
          )}
        </div>
      </div>

      <TabBar
        current={tab}
        onChange={setTab}
        tabs={[
          { id: "room", label: "Room", icon: "room" },
          { id: "files", label: "Files", icon: "folder", badge: offers },
          { id: "text", label: "Text", icon: "chat", badge: unread },
        ]}
      />
    </>
  );
}

function RoomCard({ room, status }: { room: { id: string; pin: string }; status: "connecting" | "open" | "reconnecting" }) {
  const link = roomLink(room.id);
  const onLocalhost = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
  return (
    <Card title={<span className="text-lg">Your room</span>} action={<StatusPill status={status} />}>
      <div className="grid gap-4 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center lg:grid-cols-1">
        <div className="mx-auto w-full max-w-52 rounded-3xl bg-sunken p-3 sm:max-w-none lg:max-w-56">
          <Qr text={link} label="QR code with the room link" />
        </div>
        <div className="min-w-0 space-y-4">
          <div>
            <p className="mb-1 text-sm text-muted">On the other device, scan the QR code or open this link:</p>
            <p className="select-all break-all rounded-2xl bg-sunken px-3 py-2 font-mono text-xs">{link}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <CopyButton text={link} />
              {"share" in navigator && (
                <Button icon="share" onClick={() => navigator.share({ title: "Lanet room", url: link }).catch(() => {})}>Share link</Button>
              )}
            </div>
          </div>
          <div>
            <p className="mb-1 text-sm text-muted">Then type this PIN:</p>
            <p
              className="w-fit rounded-2xl bg-accent-soft px-4 py-2 font-mono text-3xl font-bold tracking-[0.2em] text-accent sm:text-4xl"
              aria-label={`PIN ${room.pin.split("").join(" ")}`}
            >
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
  );
}

// Above a device's files and text: which device, how it is connected, and on a phone a way to switch.
function DeviceHeader({ guests, open, onSelect }: { guests: Guest[]; open: Guest; onSelect: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-3">
      {guests.length > 1 && (
        <div className="flex flex-wrap gap-2 lg:hidden" role="group" aria-label="Devices">
          {guests.map((g) => (
            <button
              key={g.id}
              type="button"
              onClick={() => onSelect(g.id)}
              aria-current={g.id === open.id}
              className={`flex min-h-11 max-w-full cursor-pointer items-center gap-2 rounded-2xl px-3 text-sm font-semibold ${g.id === open.id ? "bg-accent text-on-accent" : "bg-surface text-ink shadow-[var(--shadow-card)]"}`}
            >
              <span className="truncate">{g.name}</span>
              {g.unread > 0 && <span className="rounded-full bg-teal px-1.5 text-xs leading-5 text-on-teal">{g.unread}</span>}
            </button>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3 rounded-3xl bg-surface p-4 shadow-[var(--shadow-card)]">
        <DeviceTile name={open.name} size="size-12" />
        <div className="min-w-0 flex-1">
          <p className="break-words font-semibold">{open.name}</p>
          <div className="mt-1"><LinkPill link={open.present ? open.link : "left"} /></div>
        </div>
      </div>
      {open.present && open.link === "blocked" && <Note tone="bad">{BLOCKED_HELP}</Note>}
      {!open.present && <Note tone="warn">{open.name} isn't connected. If it comes back, it picks up here, and paused files carry on.</Note>}
    </div>
  );
}

function GuestList({ guests, selected, onSelect }: { guests: Guest[]; selected: string | null; onSelect: (id: string) => void }) {
  return (
    <ul className="flex flex-col gap-2">
      {guests.map((g) => (
        <li key={g.id}>
          <button
            type="button"
            onClick={() => onSelect(g.id)}
            aria-current={g.id === selected}
            className={`flex min-h-14 w-full cursor-pointer items-center gap-3 rounded-2xl p-2.5 text-left transition ${g.id === selected ? "bg-accent-soft ring-1 ring-accent/30" : "bg-sunken hover:bg-accent-soft"}`}
          >
            <DeviceTile name={g.name} />
            <span className="min-w-0 flex-1">
              <span className="block break-words text-sm font-semibold">{g.name}</span>
              <span className="mt-1 block"><LinkPill link={g.present ? g.link : "left"} /></span>
            </span>
            {g.unread > 0 && (
              <span className="rounded-full bg-accent px-2 text-xs font-semibold leading-5 text-on-accent" aria-label={`${g.unread} new`}>{g.unread}</span>
            )}
            <Icon name="chevron" className="size-4 shrink-0 text-muted" />
          </button>
        </li>
      ))}
    </ul>
  );
}

function StatusPill({ status }: { status: "connecting" | "open" | "reconnecting" }) {
  const text = status === "open" ? "Room open" : status === "connecting" ? "Opening…" : "Reconnecting…";
  const look = status === "open" ? "bg-teal-soft text-teal" : "bg-warn-soft text-on-warn";
  return (
    <span role="status" className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${look}`}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {text}
    </span>
  );
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
  return <Button icon={copied ? "check" : "copy"} onClick={copy}>{copied ? "Copied" : "Copy link"}</Button>;
}
