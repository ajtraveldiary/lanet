import { useEffect, useRef, useState, type DragEvent } from "react";
import { Button, Note } from "./ui";
import { MAX_FILES, type Batch, type Caps, type Transfers } from "./lib/transfers";
import { formatSize, formatTime } from "./lib/files";
import { canPickFolder, fromDrop, fromInput, type Picked } from "./lib/pick";
import { MEMORY_LIMIT, canShareFiles, chooseFolder, saveFile, savedFolderName, sinkKind } from "./lib/sinks";

const IOS_WARN = 2 * 1024 ** 3;

export function FilesPanel({ transfers, otherName, canSend }: { transfers: Transfers; otherName: string; canSend: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<{ files: Picked[]; warning: string } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  // React has no prop for the folder picker; the attribute is set by hand.
  useEffect(() => { folderInput.current?.setAttribute("webkitdirectory", ""); }, []);

  const go = (files: Picked[]) => {
    setPending(null);
    setProblem(transfers.offer(files) ? null : "Not connected right now. Try again in a moment.");
  };
  const pick = (files: Picked[]) => {
    if (!files.length) return setProblem("That folder is empty. Empty folders aren't sent.");
    if (files.length > MAX_FILES) {
      return setProblem(`That's ${files.length.toLocaleString()} files. Send at most ${MAX_FILES.toLocaleString()} at a time, for example one folder inside it at a time.`);
    }
    const warning = sendWarning(files, transfers.remote, otherName);
    if (warning) setPending({ files, warning });
    else go(files);
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!canSend) return;
    fromDrop(e.dataTransfer).then(pick, () => setProblem("Couldn't read what was dropped. Try Send files or Send folder instead."));
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
        {canPickFolder() && <Button disabled={!canSend} onClick={() => folderInput.current?.click()}>Send folder</Button>}
        <span className="hidden text-sm text-muted sm:inline">or drop files and folders here</span>
        <input ref={input} type="file" multiple hidden onChange={(e) => { pick(fromInput(e.target.files)); e.target.value = ""; }} />
        <input ref={folderInput} type="file" hidden onChange={(e) => { pick(fromInput(e.target.files)); e.target.value = ""; }} />
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

function sendWarning(files: Picked[], remote: Caps | null, name: string): string | null {
  const total = files.reduce((s, f) => s + f.file.size, 0);
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
    kind === "download" ? "Files you accept go to your downloads. Folders arrive as one .zip file." :
    kind === "browser" ? "Files you accept are kept in this browser until you tap Save. Folders arrive as one .zip file." :
    `Files you accept are kept on this page until you tap Save, up to ${formatSize(MEMORY_LIMIT)} at a time. Folders arrive as one .zip file.`;
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

// A sent folder whose name was already taken was saved as "Photos (2)"; say so.
function renamed(b: Batch): string {
  const names = new Set<string>();
  for (const f of b.files) {
    if (f.saved?.kind !== "folder" || !f.path.includes("/")) continue;
    const sent = f.path.split("/")[0], kept = f.saved.name.split("/")[0];
    if (sent !== kept) names.add(`“${kept}”`);
  }
  return names.size ? `, as ${[...names].join(", ")}` : "";
}

function BatchView({ b, transfers, otherName }: { b: Batch; transfers: Transfers; otherName: string }) {
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const count = `${b.files.length} ${b.files.length === 1 ? "file" : "files"} · ${formatSize(b.total)}`;
  const folders = b.folder ? [...new Set(b.files.filter((f) => f.path.includes("/")).map((f) => f.path.split("/")[0]))] : [];
  const zipSaved = b.zip?.saved;
  const zipFile = zipSaved?.kind === "file" ? zipSaved.file : null;
  // What waits for a Save tap: the packed .zip, or each file kept in the browser.
  const kept = zipFile ? [zipFile] : b.files.flatMap((f) => (f.saved?.kind === "file" ? [f.saved.file] : []));
  const shown = showAll ? b.files : b.files.slice(0, SHOWN);
  const willZip = !b.out && b.state === "incoming" && b.folder && sinkKind() !== "folder";

  const accept = async () => {
    setBusy(true);
    setProblem(await transfers.accept(b.id, otherName));
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
      {folders.length > 0 && (
        <p className="mt-1 break-words text-sm [overflow-wrap:anywhere]">
          {folders.length === 1 ? "Folder" : "Folders"}: <b>{folders.join(", ")}</b>
        </p>
      )}

      <ul className="mt-2 space-y-1 text-sm">
        {shown.map((f, i) => (
          <li key={i} className="flex flex-wrap items-center gap-x-2">
            <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{f.path}</span>
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
      {willZip && <p className="mt-2 text-sm text-muted">This device can't save a folder, so it arrives as one .zip file.</p>}
      {!b.out && b.state === "done" && (
        <p className="mt-2 text-sm text-muted">
          {zipSaved?.kind === "download" ? <>Saved to your downloads as “{b.zip!.name}”.</> :
            zipFile ? <>Packed into “{b.zip!.name}”. Tap Save to keep it on this device.</> :
            kept.length > 0 ? "Tap Save to keep them on this device." :
            b.where ? `Saved in ${b.where}${renamed(b)}.` : null}
        </p>
      )}

      <div className="mt-3 flex flex-wrap gap-2 empty:hidden">
        {b.state === "incoming" && (
          <>
            <Button kind="primary" disabled={busy} onClick={accept}>{busy ? "Getting ready…" : "Accept"}</Button>
            <Button onClick={() => transfers.decline(b.id)}>Decline</Button>
          </>
        )}
        {(b.state === "asking" || b.state === "active") && <Button onClick={() => transfers.cancel(b.id)}>Cancel</Button>}
        {!b.out && b.state === "done" && zipFile && <Button kind="primary" onClick={saveAll}>Save the .zip</Button>}
        {!b.out && b.state === "done" && !zipFile && kept.length > 1 && <Button onClick={saveAll}>Save all</Button>}
      </div>
    </li>
  );
}
