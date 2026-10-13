import { useEffect, useRef, useState, type DragEvent } from "react";
import { Button, Note } from "./ui";
import type { Batch, Caps, Transfers } from "./lib/transfers";
import { formatSize, formatTime } from "./lib/files";
import { MEMORY_LIMIT, canShareFiles, chooseFolder, saveFile, savedFolderName, sinkKind } from "./lib/sinks";

const IOS_WARN = 2 * 1024 ** 3;

export function FilesPanel({ transfers, otherName, canSend }: { transfers: Transfers; otherName: string; canSend: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ files: File[]; warning: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const go = (files: File[]) => {
    setPending(null);
    setProblem(transfers.offer(files) ? null : "Not connected right now. Try again in a moment.");
  };
  const pick = (files: File[]) => {
    if (!files.length) return;
    const warning = sendWarning(files, transfers.remote, otherName);
    if (warning) setPending({ files, warning });
    else go(files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (canSend) pick([...e.dataTransfer.files]);
  };

  return (
    <div
      onDragOver={(e) => { if (canSend && e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`flex flex-col gap-3 rounded-xl ${dragging ? "outline-2 outline-dashed outline-offset-4 outline-accent" : ""}`}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button kind="primary" disabled={!canSend} onClick={() => input.current?.click()}>Send files</Button>
        <span className="hidden text-sm text-muted sm:inline">or drop files here</span>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          onChange={(e) => { pick([...(e.target.files ?? [])]); e.target.value = ""; }}
        />
      </div>
      {pending && (
        <div className="space-y-2">
          <Note tone="warn">{pending.warning}</Note>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => go(pending.files)}>Send anyway</Button>
            <Button onClick={() => setPending(null)}>Don't send</Button>
          </div>
        </div>
      )}
      {problem && <Note tone="bad">{problem}</Note>}
      <ReceiveWhere />
      {transfers.batches.length > 0 && (
        <ul className="flex flex-col gap-3">
          {[...transfers.batches].reverse().map((b) => <BatchView key={b.id + (b.out ? "o" : "i")} b={b} transfers={transfers} otherName={otherName} />)}
        </ul>
      )}
    </div>
  );
}

function sendWarning(files: File[], remote: Caps | null, name: string): string | null {
  const total = files.reduce((s, f) => s + f.size, 0);
  if (remote?.sink === "browser" && remote.room !== undefined && total > remote.room) {
    return `${name} may not have room for ${formatSize(total)}: its browser has about ${formatSize(remote.room)} free.`;
  }
  if (remote?.ios && total > IOS_WARN) {
    return `${name} is an iPhone or iPad. These keep received files in the browser first, so ${formatSize(total)} may not fit.`;
  }
  if (remote?.sink === "memory" && total > MEMORY_LIMIT) {
    return `${name} can take at most ${formatSize(MEMORY_LIMIT)} at a time, so it may refuse ${formatSize(total)}.`;
  }
  return null;
}

// Tells the person where files they accept will end up, before they accept any.
function ReceiveWhere() {
  const kind = sinkKind();
  const [folder, setFolder] = useState<string | null>(null);
  useEffect(() => {
    if (kind === "folder") void savedFolderName().then(setFolder);
  }, [kind]);
  const change = async () => {
    try { setFolder((await chooseFolder()).name); } catch { /* picker closed */ }
  };
  const text =
    kind === "folder" ? (folder ? <>Files you accept are saved in the “{folder}” folder.</> : "Files you accept are saved in a folder you pick.") :
    kind === "download" ? "Files you accept go to your downloads." :
    kind === "browser" ? "Files you accept are kept in this browser until you tap Save." :
    `Files you accept are kept on this page until you tap Save, up to ${formatSize(MEMORY_LIMIT)} at a time.`;
  return (
    <div className="flex flex-wrap items-center gap-x-2 text-sm text-muted">
      <span>{text}</span>
      {kind === "folder" && folder && (
        <button type="button" onClick={change} className="min-h-8 cursor-pointer text-accent underline underline-offset-2">Change folder</button>
      )}
    </div>
  );
}

function title(b: Batch, other: string): string {
  if (b.out) {
    switch (b.state) {
      case "asking": return `Waiting for ${other} to accept`;
      case "active": return `Sending to ${other}`;
      case "done": return "Sent";
      case "declined": return `${other} declined`;
      case "cancelled": return "Cancelled";
      default: return "Didn't finish";
    }
  }
  switch (b.state) {
    case "incoming": return `${other} wants to send you`;
    case "active": return "Receiving";
    case "done": return "Received";
    case "declined": return "You declined";
    case "cancelled": return "Cancelled";
    default: return "Didn't finish";
  }
}

const SHOWN = 5;

function BatchView({ b, transfers, otherName }: { b: Batch; transfers: Transfers; otherName: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const count = `${b.files.length} ${b.files.length === 1 ? "file" : "files"} · ${formatSize(b.total)}`;
  const kept = b.files.flatMap((f) => (f.saved?.kind === "file" ? [f.saved.file] : []));
  const shown = showAll ? b.files : b.files.slice(0, SHOWN);

  const accept = async () => {
    setBusy(true);
    setProblem(await transfers.accept(b.id));
    setBusy(false);
  };
  const saveAll = async () => {
    if (canShareFiles(kept)) {
      // iPhone and iPad: the share sheet has "Save to Files" for all of them at once.
      try { await navigator.share({ files: kept }); return; } catch (e) { if ((e as DOMException)?.name === "AbortError") return; }
    }
    for (const f of kept) {
      saveFile(f);
      await new Promise((r) => setTimeout(r, 400));
    }
  };

  const pct = b.total ? Math.floor((b.done / b.total) * 100) : 100;
  const left = b.speed > 0 ? formatTime((b.total - b.done) / b.speed) : "";

  return (
    <li className="rounded-xl border border-line p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <p className="font-medium">{title(b, otherName)}</p>
        <p className="text-sm text-muted">{count}</p>
      </div>

      <ul className="mt-2 space-y-1 text-sm">
        {shown.map((f, i) => (
          <li key={i} className="flex flex-wrap items-center gap-x-2">
            <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{f.name}</span>
            <span className="text-muted">{formatSize(f.size)}</span>
            {f.state === "done" && f.saved?.kind === "file" && (
              <button type="button" onClick={() => saveFile((f.saved as { file: File }).file)} className="min-h-11 cursor-pointer rounded-md px-3 text-accent underline underline-offset-2">Save</button>
            )}
            {f.state === "failed" && <span className="text-bad">failed</span>}
          </li>
        ))}
      </ul>
      {b.files.length > SHOWN && (
        <button type="button" onClick={() => setShowAll(!showAll)} className="mt-1 min-h-8 cursor-pointer text-sm text-accent underline underline-offset-2">
          {showAll ? "Show fewer" : `Show all ${b.files.length}`}
        </button>
      )}

      {b.state === "active" && (
        <div className="mt-3">
          <progress className="h-2 w-full accent-[var(--color-accent)]" max={100} value={pct} aria-label="Progress" />
          <p className="mt-1 text-sm text-muted">
            {pct}% · {formatSize(b.done)} of {formatSize(b.total)}
            {b.speed > 0 && <> · {formatSize(b.speed)}/s</>}
            {left && <> · {left} left</>}
          </p>
        </div>
      )}

      {b.error && b.state === "failed" && <div className="mt-2"><Note tone="bad">{b.error}</Note></div>}
      {problem && <div className="mt-2"><Note tone="bad">{problem}</Note></div>}
      {!b.out && b.state === "done" && b.where && kept.length === 0 && <p className="mt-2 text-sm text-muted">Saved in {b.where}.</p>}
      {!b.out && b.state === "done" && kept.length > 0 && <p className="mt-2 text-sm text-muted">Tap Save to keep them on this device.</p>}

      <div className="mt-3 flex flex-wrap gap-2 empty:hidden">
        {b.state === "incoming" && (
          <>
            <Button kind="primary" disabled={busy} onClick={accept}>{busy ? "Getting ready…" : "Accept"}</Button>
            <Button onClick={() => transfers.decline(b.id)}>Decline</Button>
          </>
        )}
        {(b.state === "asking" || b.state === "active") && <Button onClick={() => transfers.cancel(b.id)}>Cancel</Button>}
        {!b.out && b.state === "done" && kept.length > 1 && <Button onClick={saveAll}>Save all</Button>}
      </div>
    </li>
  );
}
