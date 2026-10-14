import { useEffect, useState } from "react";
import { Button, IconTile, Note } from "./ui";
import { fileKind } from "./icons";
import { formatSize } from "./lib/files";
import { useShared, type SharedSet } from "./lib/shared";
import type { Transfers } from "./lib/transfers";

// A device that shared files can go to: the main device for a joined phone, or any joined device for the main one.
export type Target = { id: string; name: string; ready: boolean; transfers: Transfers; sendText: (body: string) => boolean };

// What was shared to Lanet from another app, waiting to be sent. Removed from the device only once the files
// have arrived; if they're declined or stop, they wait again.
export function SharedWaiting({ targets, preferred, notReady }: { targets: Target[]; preferred?: string | null; notReady: string }) {
  const { sets, refresh, remove } = useShared();
  const [sending, setSending] = useState<Record<string, { to: Target; batch: string }>>({});
  const [problem, setProblem] = useState<Record<string, string>>({});

  // Follow each send: gone from the device once it's arrived; back to waiting if it didn't.
  useEffect(() => {
    for (const [setId, s] of Object.entries(sending)) {
      const b = s.to.transfers.batches.find((x) => x.id === s.batch);
      if (!b) continue;
      if (b.state === "done") {
        void remove(setId);
        setSending(({ [setId]: _, ...rest }) => rest);
      } else if (b.state === "declined" || b.state === "cancelled" || b.state === "failed") {
        setProblem((p) => ({ ...p, [setId]: `Not sent: ${s.to.name} ${b.state === "declined" ? "declined" : "didn't get it"}. You can send it again.` }));
        setSending(({ [setId]: _, ...rest }) => rest);
      }
    }
  });

  if (!sets.length) return null;

  const send = (set: SharedSet, to: Target) => {
    setProblem(({ [set.id]: _, ...rest }) => rest);
    if (set.text) to.sendText(set.text);
    if (!set.files.length) { void remove(set.id); return; }
    const batch = to.transfers.offer(set.files.map((file) => ({ file, path: file.name })));
    if (!batch) return setProblem((p) => ({ ...p, [set.id]: "Not connected right now. Try again in a moment." }));
    setSending((s) => ({ ...s, [set.id]: { to, batch } }));
  };

  return (
    <section aria-label="Shared to Lanet" className="flex flex-col gap-3 rounded-3xl bg-surface p-4 shadow-[var(--shadow-card)] ring-1 ring-teal/30 sm:p-5">
      <div className="flex items-center gap-3">
        <IconTile name="receive" tone="bg-teal-soft text-teal" />
        <div className="min-w-0 flex-1">
          <h2 className="font-semibold">Waiting to send</h2>
          <p className="text-sm text-muted">Shared to Lanet from another app. Kept on this device until sent, for up to a day.</p>
        </div>
      </div>
      {sets.map((set) => (
        <SetView
          key={set.id}
          set={set}
          targets={targets}
          preferred={preferred}
          notReady={notReady}
          sendingTo={sending[set.id]?.to.name}
          problem={problem[set.id]}
          onSend={(to) => send(set, to)}
          onRemove={() => { void remove(set.id); refresh(); }}
        />
      ))}
    </section>
  );
}

const SHOWN = 3;

function SetView({ set, targets, preferred, notReady, sendingTo, problem, onSend, onRemove }: {
  set: SharedSet; targets: Target[]; preferred?: string | null; notReady: string;
  sendingTo?: string; problem?: string; onSend: (to: Target) => void; onRemove: () => void;
}) {
  const [choice, setChoice] = useState<string | null>(null);
  const to = targets.find((t) => t.id === choice) ?? targets.find((t) => t.id === preferred) ?? targets[0];
  const total = set.files.reduce((n, f) => n + f.size, 0);
  return (
    <div className="flex flex-col gap-3 rounded-2xl bg-sunken p-3">
      {set.files.length > 0 && (
        <ul className="flex flex-col gap-1.5 text-sm">
          {set.files.slice(0, SHOWN).map((f) => (
            <li key={f.name} className="flex items-center gap-2">
              <IconTile name={fileKind(f.name, f.type).icon} tone={fileKind(f.name, f.type).tone} size="size-8" />
              <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{f.name}</span>
              <span className="text-muted">{formatSize(f.size)}</span>
            </li>
          ))}
          {set.files.length > SHOWN && <li className="text-muted">and {set.files.length - SHOWN} more · {formatSize(total)} in all</li>}
        </ul>
      )}
      {set.text && <p className="line-clamp-3 whitespace-pre-wrap break-words rounded-xl bg-surface px-3 py-2 text-sm [overflow-wrap:anywhere]">{set.text}</p>}
      {targets.length > 1 && !sendingTo && (
        <div className="flex flex-wrap gap-2" role="group" aria-label="Send to">
          {targets.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === to?.id}
              onClick={() => setChoice(t.id)}
              className={`min-h-11 max-w-full cursor-pointer truncate rounded-2xl px-3 text-sm font-semibold ${t.id === to?.id ? "bg-accent text-on-accent" : "bg-surface text-ink"}`}
            >
              {t.name}
            </button>
          ))}
        </div>
      )}
      {problem && <Note tone="bad">{problem}</Note>}
      {sendingTo ? (
        <p className="text-sm text-muted">Sending to {sendingTo}… Follow it under Files.</p>
      ) : !to ? (
        <p className="text-sm text-muted">{notReady}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button kind="primary" icon="send" className="max-w-full" disabled={!to.ready} onClick={() => onSend(to)}>
            <span className="truncate">Send to {to.name}</span>
          </Button>
          <Button icon="x" onClick={onRemove}>Remove</Button>
        </div>
      )}
      {!to && <div><Button icon="x" onClick={onRemove}>Remove</Button></div>}
      {to && !to.ready && !sendingTo && <p className="text-sm text-muted">{to.name} isn't connected right now.</p>}
    </div>
  );
}
