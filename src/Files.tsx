import { useEffect, useRef, useState, type DragEvent } from "react";
import { Button, DeviceTile, IconTile, Note, Ring } from "./ui";
import { Icon, fileKind } from "./icons";
import { MAX_FILES, type Batch, type Caps, type TFile, type Transfers } from "./lib/transfers";
import { formatSize, formatTime } from "./lib/files";
import { deviceName } from "./lib/device";
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
      className={`flex flex-col gap-3 rounded-2xl ${dragging ? "outline-2 outline-dashed outline-offset-4 outline-accent" : ""}`}
    >
      <div className="flex flex-wrap gap-2">
        <Button kind="primary" icon="send" className="flex-1 sm:flex-none" disabled={!canSend} onClick={() => input.current?.click()}>Send files</Button>
        {canPickFolder() && <Button icon="folder" className="flex-1 sm:flex-none" disabled={!canSend} onClick={() => folderInput.current?.click()}>Send folder</Button>}
        <input ref={input} type="file" multiple hidden onChange={(e) => { pick(fromInput(e.target.files)); e.target.value = ""; }} />
        <input ref={folderInput} type="file" hidden onChange={(e) => { pick(fromInput(e.target.files)); e.target.value = ""; }} />
      </div>
      <p className="hidden rounded-2xl border border-dashed border-line px-4 py-3 text-center text-sm text-muted sm:block">
        or drop files and folders here
      </p>
      {pending && (
        <div className="flex flex-col gap-2">
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
    <div className="flex items-start gap-3 rounded-2xl bg-teal-soft/60 p-3 text-sm">
      <IconTile name="receive" tone="bg-teal-soft text-teal" size="size-8" />
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2">
        <span className="text-ink/80">{text}</span>
        {kind === "folder" && folder && (
          <button type="button" onClick={change} className="min-h-8 cursor-pointer font-semibold text-teal underline underline-offset-2">Change folder</button>
        )}
      </div>
    </div>
  );
}

function title(b: Batch, other: string): string {
  if (b.out) {
    switch (b.state) {
      case "asking": return `Waiting for ${other} to accept`;
      case "active": return `Sending to ${other}`;
      case "paused": return `Paused: waiting for ${other}`;
      case "done": return "Sent";
      case "declined": return `${other} declined`;
      case "cancelled": return "Cancelled";
      default: return "Didn't finish";
    }
  }
  switch (b.state) {
    case "incoming": return b.continues ? `${other} wants to carry on sending` : `${other} wants to send you`;
    case "active": return `Receiving from ${other}`;
    case "paused": return `Paused: waiting for ${other}`;
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
  const moving = b.state === "active" || b.state === "paused";
  const tone = b.out ? "text-accent" : "text-teal";

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
  const filesDone = b.files.filter((f) => f.state === "done").length;
  const highlight = b.state === "incoming" ? "bg-accent-soft/50 ring-1 ring-accent/30" : "bg-sunken";

  return (
    <li className={`flex flex-col gap-3 rounded-3xl p-3 sm:p-4 ${highlight}`}>
      {moving ? (
        <div className="flex flex-col items-center gap-3 pt-2">
          <Ring value={b.total ? b.done / b.total : 1} size={176} stroke={6} tone={tone}>
            <span className="flex flex-col items-center gap-2">
              <span className="flex items-center gap-1.5">
                <DeviceTile name={b.out ? deviceName() : otherName} size="size-11" />
                <span className={`inline-flex size-7 items-center justify-center rounded-full bg-surface ${tone}`}>
                  <Icon name={b.state === "paused" ? "pause" : "arrow"} className="size-4" />
                </span>
                <DeviceTile name={b.out ? otherName : deviceName()} size="size-11" />
              </span>
              <span className="text-2xl font-bold text-ink">{pct}%</span>
            </span>
          </Ring>
          <p className="text-center font-semibold">{title(b, otherName)}</p>
          <dl className="grid w-full grid-cols-3 divide-x divide-line rounded-2xl bg-surface py-2.5 text-center">
            <div className="px-1"><dt className="text-xs text-muted">Files</dt><dd className="text-sm font-semibold">{filesDone} of {b.files.length}</dd></div>
            <div className="px-1"><dt className="text-xs text-muted">Size</dt><dd className="text-sm font-semibold">{formatSize(b.total)}</dd></div>
            <div className="px-1"><dt className="text-xs text-muted">Speed</dt><dd className="text-sm font-semibold">{b.state === "paused" ? "Paused" : b.speed > 0 ? `${formatSize(b.speed)}/s` : "…"}</dd></div>
          </dl>
          <p className="text-sm text-muted">
            {formatSize(b.done)} of {formatSize(b.total)}{b.state === "active" && left && <> · {left} left</>}
          </p>
        </div>
      ) : (
        <div className="flex items-start gap-3">
          <IconTile name={b.out ? "send" : "receive"} tone={b.out ? "bg-accent-soft text-accent" : "bg-teal-soft text-teal"} />
          <div className="min-w-0 flex-1">
            <p className="font-semibold">{title(b, otherName)}</p>
            <p className="text-sm text-muted">{count}</p>
          </div>
        </div>
      )}

      {folders.length > 0 && (
        <p className="break-words text-sm [overflow-wrap:anywhere]">
          <Icon name="folder" className="mr-1 inline size-4 align-[-3px] text-muted" />
          {folders.length === 1 ? "Folder" : "Folders"}: <b>{folders.join(", ")}</b>
        </p>
      )}

      <ul className="flex flex-col gap-2">
        {shown.map((f, i) => <FileRow key={i} f={f} live={moving} tone={tone} />)}
      </ul>
      {b.files.length > SHOWN && (
        <button type="button" onClick={() => setShowAll(!showAll)} className="min-h-11 w-fit cursor-pointer text-sm font-semibold text-accent underline underline-offset-2">
          {showAll ? "Show fewer" : `Show all ${b.files.length}`}
        </button>
      )}

      {b.state === "paused" && (
        <Note tone="warn">
          {b.orphan
            ? `${otherName} no longer has this transfer (its page may have been reloaded). Pick the same files there and send them again: they carry on from here instead of starting over.`
            : "The connection dropped. This carries on by itself when both devices are back. Keep this page open."}
        </Note>
      )}
      {b.state === "incoming" && b.continues && (
        <p className="text-sm text-muted">These are the files that stopped earlier. Accept to carry on: {formatSize(b.done)} of {formatSize(b.total)} is already here.</p>
      )}
      {b.error && b.state === "failed" && <Note tone="bad">{b.error}</Note>}
      {problem && <Note tone="bad">{problem}</Note>}
      {willZip && <p className="text-sm text-muted">This device can't save a folder, so it arrives as one .zip file.</p>}
      {!b.out && b.state === "done" && (
        <p className="text-sm text-muted">
          {zipSaved?.kind === "download" ? <>Saved to your downloads as “{b.zip!.name}”.</> :
            zipFile ? <>Packed into “{b.zip!.name}”. Tap Save to keep it on this device.</> :
            kept.length > 0 ? "Tap Save to keep them on this device." :
            b.where ? `Saved in ${b.where}${renamed(b)}.` : null}
        </p>
      )}

      <div className="flex flex-wrap gap-2 empty:hidden">
        {b.state === "incoming" && (
          <>
            <Button kind="teal" icon="receive" className="flex-1 sm:flex-none" disabled={busy} onClick={accept}>{busy ? "Getting ready…" : "Accept"}</Button>
            <Button className="flex-1 sm:flex-none" onClick={() => transfers.decline(b.id)}>Decline</Button>
          </>
        )}
        {(b.state === "asking" || b.state === "active" || b.state === "paused") && <Button icon="x" onClick={() => transfers.cancel(b.id)}>Cancel</Button>}
        {!b.out && b.state === "done" && zipFile && <Button kind="teal" icon="receive" onClick={saveAll}>Save the .zip</Button>}
        {!b.out && b.state === "done" && !zipFile && kept.length > 1 && <Button kind="teal" icon="receive" onClick={saveAll}>Save all</Button>}
      </div>
    </li>
  );
}

// One file: its kind, its name and size, and how far it has got.
function FileRow({ f, live, tone }: { f: TFile; live: boolean; tone: string }) {
  const kind = fileKind(f.path, f.type);
  const partly = live && f.done > 0 && f.done < f.size;
  return (
    <li className="flex items-center gap-3 rounded-2xl bg-surface p-2.5">
      <IconTile name={kind.icon} tone={kind.tone} />
      <div className="min-w-0 flex-1">
        <p className="break-words text-sm font-semibold [overflow-wrap:anywhere]">{f.path}</p>
        <p className="text-xs text-muted">{partly ? `${formatSize(f.done)} / ${formatSize(f.size)}` : formatSize(f.size)}</p>
      </div>
      {f.state === "done" && f.saved?.kind === "file" ? (
        <button type="button" onClick={() => saveFile((f.saved as { file: File }).file)} className="min-h-11 cursor-pointer rounded-xl px-3 text-sm font-semibold text-teal hover:bg-teal-soft">Save</button>
      ) : f.state === "done" ? (
        <span className="inline-flex size-7 items-center justify-center rounded-full bg-teal-soft text-teal" aria-label="Done"><Icon name="check" className="size-4" /></span>
      ) : f.state === "failed" ? (
        <span className="text-xs font-semibold text-bad">Failed</span>
      ) : live ? (
        <Ring value={f.size ? f.done / f.size : 0} size={28} stroke={3} tone={tone} />
      ) : null}
    </li>
  );
}
