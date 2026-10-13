// Sending and receiving files with one other device over the direct connection.
//
// The sender offers a batch of files on the control channel; nothing moves until the receiver accepts.
// Each file then gets its own data channel, labelled "f:<batch>:<file>:<starting byte>": binary pieces,
// then "end". The receiver answers on the same channel with "ack:<bytes written>" every so often and
// "done" (or "err:<reason>") at the end. The sender never runs more than WINDOW bytes ahead of what the
// receiver has written, so a slow disk can't fill memory.
//
// A dropped connection pauses a batch instead of failing it: both sides keep what they have (the file
// being written stays open). When a new connection comes up, each side says which batches it still has
// ("hello"), and the receiver asks for the rest of each paused one ("resume", from the byte it got to).
// If the sending page was reloaded, the receiver keeps the paused batch; when the same files are offered
// again, accepting carries on where it stopped.
import { randomKey, type PeerLink } from "./peer";
import { openSink, sinkKind, browserRoom, type FileWriter, type Saved, type Sink, type SinkKind } from "./sinks";
import { isIOS, safePath } from "./files";
import type { Picked } from "./pick";
import { ZipBatch, zipLength, zipName } from "./zip";

export type FileState = "waiting" | "moving" | "done" | "failed";
// `path` is the file's place inside a sent folder ("Photos/2024/a.jpg"), or just its name.
export type TFile = { path: string; size: number; type: string; modified: number; done: number; state: FileState; saved?: Saved };
export type BatchState = "asking" | "incoming" | "active" | "paused" | "done" | "declined" | "cancelled" | "failed";
export type Batch = {
  id: string;
  out: boolean;
  files: TFile[];
  total: number;
  done: number;
  state: BatchState;
  speed: number;   // bytes per second, smoothed
  error?: string;
  where?: string;   // receiver: where the files went
  folder: boolean;  // has files inside folders
  zip?: { name: string; saved?: Saved };  // receiver: the folder arrives packed into this .zip
  orphan?: boolean;     // receiver, paused: the sending page lost it; the same files offered again continue it
  continues?: string;   // receiver, incoming: this offer carries on that paused batch
};
export type Caps = { ios: boolean; sink: SinkKind; room?: number };

const READ_BLOCK = 2 * 1024 ** 2;  // read from disk 2 MB at a time
const HIGH = 8 * 1024 ** 2;        // most bytes waiting in the connection's own buffer
const WINDOW = 16 * 1024 ** 2;     // most bytes sent but not yet written on the other side
const ACK_EVERY = 1024 ** 2;
export const MAX_FILES = 10_000;
const MAX_SIZE = 2 ** 50;

const OPEN: BatchState[] = ["asking", "incoming", "active", "paused"];
export const isOpen = (b: Batch) => OPEN.includes(b.state);
const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));
const ids = (v: unknown) => new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

// The connection went away mid-file: pause, don't fail.
class Dropped extends Error {
  constructor() { super("The connection dropped"); }
}

// The receiver's place in the file it is writing. Kept through a dropped connection, so the file
// stays open and the rest can be appended.
type Rx = { i: number; writer: FileWriter | null; received: number; written: number; chain: Promise<void> };

export class Transfers {
  batches: Batch[] = [];
  remote: Caps | null = null;
  private peer: PeerLink | null = null;
  private outFiles = new Map<string, File[]>();
  private sinks = new Map<string, Sink>();
  private zips = new Map<string, ZipBatch>();
  private rx = new Map<string, Rx>();
  private halts = new Map<string, () => void>();  // closes the channel a batch is using right now
  private sending: Promise<void> = Promise.resolve();
  private samples = new Map<string, { at: number; done: number }>();

  constructor(private changed: () => void) {}

  // A new direct connection to the same device.
  attach(peer: PeerLink) {
    if (this.peer === peer) return;
    this.detach();
    this.peer = peer;
    void this.sayHello();
  }

  // The connection is gone, perhaps for a moment: whatever was moving pauses.
  detach() {
    this.peer = null;
    this.remote = null;
    for (const b of this.batches) this.pause(b);
    this.changed();
  }

  // The room has closed, or this device is gone for good: nothing can continue.
  end(why: string) {
    this.peer = null;
    for (const b of this.batches) if (isOpen(b)) this.stop(b, "failed", why);
    this.changed();
  }

  private async sayHello() {
    const peer = this.peer;
    const sink = sinkKind();
    const room = sink === "browser" ? await browserRoom() : undefined;
    // Which batches this side still has, so the other side can tell what to resume and what was lost.
    const open = this.batches.filter((b) => isOpen(b) && !b.orphan).map((b) => b.id);
    const done = this.batches.filter((b) => b.state === "done").map((b) => b.id);
    peer?.send({ t: "hello", ios: isIOS(), sink, room, open, done });
  }

  // Answers true when the control message was about files.
  handle(m: Record<string, unknown>): boolean {
    switch (m.t) {
      case "hello": this.hello(m); return true;
      case "offer": this.offered(m); return true;
      case "accept": {
        const b = this.find(m.id, true);
        if (b?.state === "asking") this.startFrom(b, m.file, m.at);
        return true;
      }
      case "resume": {
        const b = this.find(m.id, true);
        if (b && (b.state === "paused" || b.state === "active")) this.startFrom(b, m.file, m.at);
        return true;
      }
      case "decline": {
        const b = this.find(m.id, true);
        if (b?.state === "asking") { b.state = "declined"; this.outFiles.delete(b.id); this.changed(); }
        return true;
      }
      case "cancel": {
        const b = this.find(m.id, true) ?? this.find(m.id, false);
        if (b && isOpen(b)) this.stop(b, "cancelled");
        return true;
      }
    }
    return false;
  }

  offer(picked: Picked[]): boolean {
    const files: TFile[] = picked.map(({ file, path }) => (
      { path, size: file.size, type: file.type, modified: file.lastModified, done: 0, state: "waiting" }
    ));
    const b: Batch = {
      id: randomKey(),
      out: true,
      files,
      total: files.reduce((s, f) => s + f.size, 0),
      done: 0,
      state: "asking",
      speed: 0,
      folder: files.some((f) => f.path.includes("/")),
    };
    const list = files.map(({ path, size, type, modified }) => ({ path, size, type, modified }));
    if (!this.peer?.send({ t: "offer", id: b.id, files: list })) return false;
    this.outFiles.set(b.id, picked.map((p) => p.file));
    this.batches.push(b);
    this.changed();
    return true;
  }

  // From a click: picking a folder or asking for permission needs one.
  // `from` names the sending device, for the .zip's name when a folder has to be packed.
  async accept(id: string, from: string): Promise<string | null> {
    const b = this.find(id, false);
    if (b?.state !== "incoming") return null;
    const old = b.continues ? this.find(b.continues, false) : undefined;
    if (old?.state === "paused" && old.orphan) return this.carryOn(b, old);

    const kind = sinkKind();
    const packed = b.folder && kind !== "folder";
    let sink: Sink, zip: ZipBatch | null = null;
    try {
      sink = await openSink(kind, packed ? zipLength(b.files) : b.total);
      if (packed) {
        const name = zipName(b.files, from);
        zip = new ZipBatch(b.files, await sink.open(name, zipLength(b.files), "application/zip"));
        b.zip = { name };
      }
    } catch (e) {
      if ((e as DOMException)?.name === "AbortError") return null;  // closed the folder picker
      return reason(e);
    }
    if (b.state !== "incoming" || !this.peer?.send({ t: "accept", id })) {
      zip?.abort("Cancelled");
      return b.state === "incoming" ? "Not connected right now. Try again in a moment." : null;
    }
    this.sinks.set(id, sink);
    if (zip) this.zips.set(id, zip);
    b.where = sink.where;
    b.state = "active";
    this.changed();
    return null;
  }

  decline(id: string) {
    const b = this.find(id, false);
    if (b?.state !== "incoming") return;
    b.state = "declined";
    this.peer?.send({ t: "decline", id });
    this.changed();
  }

  cancel(id: string) {
    const b = this.batches.find((x) => x.id === id);
    if (!b || !isOpen(b)) return;
    this.stop(b, "cancelled");
    this.peer?.send({ t: "cancel", id });
  }

  // A data channel the other device opened: one file of a batch this device accepted.
  channel(ch: RTCDataChannel) {
    const m = /^f:([a-z0-9]+):(\d+):(\d+)$/.exec(ch.label);
    const b = m && this.find(m[1], false);
    const i = m ? Number(m[2]) : -1, at = m ? Number(m[3]) : -1;
    if (!b || !this.sinks.has(b.id) || b.state !== "active" || i >= b.files.length) return ch.close();
    this.receive(b, i, at, ch);
  }

  private hello(m: Record<string, unknown>) {
    this.remote = { ios: m.ios === true, sink: m.sink as SinkKind, room: typeof m.room === "number" ? m.room : undefined };
    const open = ids(m.open), done = ids(m.done);
    for (const b of this.batches) {
      if (!isOpen(b) || open.has(b.id)) continue;
      if (b.out && done.has(b.id)) {
        // It all arrived; only the last "done" was lost with the connection.
        for (const f of b.files) { f.state = "done"; f.done = f.size; }
        this.complete(b);
      } else if (!b.out && b.state === "paused") {
        b.orphan = true;
      } else {
        this.stop(b, "failed", "Stopped on the other device. Send it again if you still need it.");
      }
    }
    for (const b of this.batches) if (!b.out && b.state === "paused" && !b.orphan) void this.askToResume(b);
    this.changed();
  }

  private offered(m: Record<string, unknown>) {
    if (typeof m.id !== "string" || !/^[a-z0-9]+$/.test(m.id) || this.batches.some((x) => x.id === m.id)) return;
    if (!Array.isArray(m.files) || !m.files.length || m.files.length > MAX_FILES) return;
    const files: TFile[] = [];
    for (const f of m.files as Record<string, unknown>[]) {
      const size = Number(f?.size);
      if (!Number.isSafeInteger(size) || size < 0 || size > MAX_SIZE) return;
      files.push({
        path: safePath(f.path),
        size,
        type: typeof f.type === "string" ? f.type.slice(0, 100) : "",
        modified: Number.isSafeInteger(f.modified) ? (f.modified as number) : 0,
        done: 0,
        state: "waiting",
      });
    }
    const b: Batch = {
      id: m.id, out: false, files, total: files.reduce((s, f) => s + f.size, 0), done: 0, state: "incoming", speed: 0,
      folder: files.some((f) => f.path.includes("/")),
    };
    // The same files as a batch the sending page lost: accepting this one carries that one on.
    const old = this.batches.find((x) => x.orphan && x.state === "paused" && sameFiles(x.files, files));
    if (old) { b.continues = old.id; b.done = old.done; }
    this.batches.push(b);
    this.changed();
  }

  // Accepting an offer that continues a paused batch: it takes over that batch's place, its open file
  // and its half-written data, and asks for the rest only.
  private async carryOn(b: Batch, old: Batch): Promise<string | null> {
    const rx = this.rx.get(old.id);
    await rx?.chain;
    if (!this.peer) return "Not connected right now. Try again in a moment.";
    b.files.forEach((f, k) => Object.assign(f, { done: old.files[k].done, state: old.files[k].state, saved: old.files[k].saved }));
    b.where = old.where;
    b.zip = old.zip;
    for (const map of [this.sinks, this.zips, this.rx] as Map<string, unknown>[]) {
      if (map.has(old.id)) { map.set(b.id, map.get(old.id)); map.delete(old.id); }
    }
    this.batches = this.batches.filter((x) => x !== old);
    b.continues = undefined;
    const { file, at } = this.resumePoint(b);
    b.state = "active";
    this.progress(b);
    this.peer.send({ t: "accept", id: b.id, file, at });
    return null;
  }

  // Where the receiver got to: the first file not yet done, and how much of it is written.
  private resumePoint(b: Batch) {
    const file = Math.max(0, b.files.findIndex((f) => f.state !== "done"));
    const rx = this.rx.get(b.id);
    return { file, at: rx && rx.i === file ? rx.written : 0 };
  }

  private async askToResume(b: Batch) {
    await this.rx.get(b.id)?.chain;  // everything that arrived before the drop is written first
    if (b.state !== "paused" || !this.peer) return;
    const { file, at } = this.resumePoint(b);
    b.state = "active";
    this.samples.delete(b.id);
    this.peer.send({ t: "resume", id: b.id, file, at });
    this.changed();
  }

  private find(id: unknown, out: boolean) {
    return this.batches.find((b) => b.id === id && b.out === out);
  }

  private pause(b: Batch) {
    if (b.state !== "active") return;
    b.state = "paused";
    b.speed = 0;
    this.samples.delete(b.id);
    this.halts.get(b.id)?.();
    this.halts.delete(b.id);
    this.changed();
  }

  private stop(b: Batch, state: BatchState, why?: string) {
    b.state = state;
    if (why) b.error = why;
    b.orphan = undefined;
    this.halts.get(b.id)?.();
    this.halts.delete(b.id);
    const rx = this.rx.get(b.id);
    if (rx) { const f = b.files[rx.i]; if (f.state !== "done") f.state = "failed"; void rx.writer?.abort(); }
    this.rx.delete(b.id);
    this.outFiles.delete(b.id);
    this.sinks.delete(b.id);
    this.zips.get(b.id)?.abort(why ?? "Cancelled");
    this.zips.delete(b.id);
    this.changed();
  }

  private progress(b: Batch) {
    b.done = b.files.reduce((s, f) => s + f.done, 0);
    const now = performance.now();
    const last = this.samples.get(b.id);
    if (!last) this.samples.set(b.id, { at: now, done: b.done });
    else if (now - last.at >= 1000) {
      const rate = ((b.done - last.done) * 1000) / (now - last.at);
      b.speed = b.speed ? b.speed * 0.6 + rate * 0.4 : rate;
      this.samples.set(b.id, { at: now, done: b.done });
    }
    this.changed();
  }

  private finished(b: Batch) {
    if (!b.files.every((f) => f.state === "done") || b.state !== "active") return;
    const zip = this.zips.get(b.id);
    // A packed folder is done once the .zip itself is finished and saved.
    if (zip) {
      zip.done.then(
        (saved) => { if (b.zip) b.zip.saved = saved; this.complete(b); },
        (e) => { if (b.state === "active") this.stop(b, "failed", reason(e)); },
      );
    } else {
      this.complete(b);
    }
  }

  private complete(b: Batch) {
    if (!isOpen(b)) return;
    b.state = "done";
    b.done = b.total;
    this.halts.delete(b.id);
    this.rx.delete(b.id);
    this.outFiles.delete(b.id);
    this.sinks.delete(b.id);
    this.zips.delete(b.id);
    this.changed();
  }

  // The receiver accepted (or asked for the rest): send from that file and byte on.
  private startFrom(b: Batch, file: unknown, at: unknown) {
    const files = this.outFiles.get(b.id);
    const i = Number(file ?? 0), from = Number(at ?? 0);
    if (!files || !Number.isInteger(i) || i < 0 || i >= files.length || !Number.isSafeInteger(from) || from < 0 || from > files[i].size) {
      this.stop(b, "failed", "The other device asked for a part that doesn't exist");
      this.peer?.send({ t: "cancel", id: b.id });
      return;
    }
    b.files.forEach((f, k) => {
      if (k < i) { f.state = "done"; f.done = f.size; }
      else if (k === i) { f.done = from; f.state = "waiting"; }
    });
    b.state = "active";
    this.samples.delete(b.id);
    this.progress(b);
    // Batches go out one at a time, so a second one doesn't halve the speed of the first.
    this.sending = this.sending.then(() => this.send(b, i, from)).catch(() => {});
  }

  private async send(b: Batch, first: number, from: number) {
    const files = this.outFiles.get(b.id);
    if (!files || b.state !== "active") return;
    try {
      for (let i = first; i < files.length; i++) {
        if (b.state !== "active") return;
        b.files[i].state = "moving";
        await this.sendFile(b, i, files[i], i === first ? from : 0);
        b.files[i].state = "done";
        b.files[i].done = files[i].size;
        this.progress(b);
      }
      this.finished(b);
    } catch (e) {
      if (b.state !== "active") return;
      if (e instanceof Dropped || !this.peer) return this.pause(b);
      this.stop(b, "failed", reason(e));
      this.peer?.send({ t: "cancel", id: b.id });
    }
  }

  private async sendFile(b: Batch, i: number, file: File, start: number) {
    const peer = this.peer;
    if (!peer) throw new Dropped();
    const f = b.files[i];
    const ch = peer.openChannel(`f:${b.id}:${i}:${start}`);
    ch.binaryType = "arraybuffer";
    ch.bufferedAmountLowThreshold = HIGH / 4;
    let acked = start, sent = start;
    let broken: Error | null = null;
    let wake: (() => void) | null = null;
    const nudge = () => { const w = wake; wake = null; w?.(); };
    let answered: (v: Error | null) => void;
    const answer = new Promise<Error | null>((r) => { answered = r; });
    const breakWith = (e: Error) => { broken ??= e; answered(broken); nudge(); };
    ch.onbufferedamountlow = nudge;
    ch.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      if (e.data.startsWith("ack:")) {
        acked = Math.max(acked, Number(e.data.slice(4)) || 0);
        f.done = Math.min(acked, f.size);
        this.progress(b);
        nudge();
      } else if (e.data === "done") answered(null);
      else if (e.data.startsWith("err:")) breakWith(new Error(e.data.slice(4) || "The other device couldn't save the file"));
    };
    ch.onclose = () => breakWith(new Dropped());
    this.halts.set(b.id, () => { breakWith(new Dropped()); ch.close(); });
    // The channel can close between two pieces, before its close event arrives.
    const put = (data: string | Uint8Array<ArrayBuffer>) => {
      if (ch.readyState !== "open") throw broken ?? new Dropped();
      ch.send(data as string);
    };

    await new Promise<void>((ok) => {
      if (ch.readyState === "open") return ok();
      ch.onopen = () => ok();
      void answer.then(() => ok());
    });
    const piece = peer.chunkSize;
    while (sent < file.size) {
      if (broken) throw broken;
      const end = Math.min(file.size, sent + READ_BLOCK);
      let block: Uint8Array<ArrayBuffer>;
      try {
        block = new Uint8Array(await file.slice(sent, end).arrayBuffer());
      } catch {
        throw new Error(`Couldn't read “${f.path}”. Was it moved or deleted?`);
      }
      for (let o = 0; o < block.length; o += piece) {
        while (!broken && (ch.bufferedAmount > HIGH || sent + o - acked > WINDOW)) await new Promise<void>((r) => { wake = r; });
        if (broken) throw broken;
        put(block.subarray(o, Math.min(block.length, o + piece)));
      }
      sent = end;
    }
    if (broken) throw broken;
    put("end");
    const err = await answer;
    if (err) throw err;
    ch.onclose = null;
    this.halts.delete(b.id);
    ch.close();
  }

  private receive(b: Batch, i: number, at: number, ch: RTCDataChannel) {
    ch.binaryType = "arraybuffer";
    const f = b.files[i];
    let rx = this.rx.get(b.id);
    const refuse = (why: string) => { if (ch.readyState === "open") ch.send("err:" + why); else ch.onopen = () => { ch.send("err:" + why); ch.close(); }; };
    if (!rx || rx.i !== i) {
      // A new file: the one before it must be finished, and this one starts at its first byte.
      if (at !== 0 || (rx && b.files[rx.i].state !== "done")) return refuse("The transfer got out of step. Send it again.");
      const zip = this.zips.get(b.id);
      const opened = zip ? Promise.resolve(zip.entry(i)) : this.sinks.get(b.id)!.open(f.path, f.size, f.type);
      rx = { i, writer: null, received: 0, written: 0, chain: Promise.resolve() };
      const r = rx;
      rx.chain = opened.then((w) => { r.writer = w; });
      this.rx.set(b.id, rx);
    } else if (at !== rx.written) {
      return refuse("The transfer got out of step. Send it again.");
    }
    const r = rx;
    r.received = r.written;
    f.state = "moving";
    let lastAck = r.written, over = false;
    // Receipts into a channel that just closed are dropped: the drop itself is handled by onclose.
    const tell = (s: string) => { if (ch.readyState === "open") ch.send(s); };
    const fail = (why: string) => {
      if (over || b.state !== "active") return;
      over = true;
      tell("err:" + why);
      this.stop(b, "failed", why);
    };
    const step = (fn: () => Promise<void>) => {
      r.chain = r.chain.then(() => (over ? undefined : fn())).catch((e) => fail(reason(e)));
    };
    this.halts.set(b.id, () => { over = true; ch.close(); });
    ch.onmessage = (e) => {
      if (over) return;
      if (typeof e.data === "string") {
        if (e.data === "end") step(async () => {
          if (r.received !== f.size) throw new Error("The file arrived incomplete");
          f.saved = await r.writer!.close();
          over = true;
          f.state = "done";
          f.done = f.size;
          tell("ack:" + r.written);
          tell("done");
          this.halts.delete(b.id);
          this.progress(b);
          this.finished(b);
        });
        return;
      }
      const buf = e.data as ArrayBuffer, len = buf.byteLength;
      r.received += len;
      if (r.received > f.size) return fail("More data arrived than was offered");
      step(async () => {
        await r.writer!.write(buf);
        r.written += len;
        f.done = r.written;
        if (r.written - lastAck >= ACK_EVERY) { lastAck = r.written; tell("ack:" + r.written); }
        this.progress(b);
      });
    };
    // The connection went: keep the file open and wait for it to come back.
    ch.onclose = () => { if (!over && f.state !== "done") { over = true; this.pause(b); } };
  }
}

function sameFiles(a: TFile[], b: TFile[]): boolean {
  return a.length === b.length && a.every((f, k) => f.path === b[k].path && f.size === b[k].size && f.modified === b[k].modified);
}
