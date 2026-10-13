// Sending and receiving files with one other device over the direct connection.
//
// The sender offers a batch of files on the control channel; nothing moves until the receiver accepts.
// Each file then gets its own data channel: binary pieces, then "end". The receiver answers on the same
// channel with "ack:<bytes written>" every so often and "done" (or "err:<reason>") at the end. The sender
// never runs more than WINDOW bytes ahead of what the receiver has written, so a slow disk can't fill memory.
import { randomKey, type PeerLink } from "./peer";
import { openSink, sinkKind, browserRoom, type FileWriter, type Saved, type Sink, type SinkKind } from "./sinks";
import { isIOS, safePath } from "./files";
import type { Picked } from "./pick";
import { ZipBatch, zipLength, zipName } from "./zip";

export type FileState = "waiting" | "moving" | "done" | "failed";
// `path` is the file's place inside a sent folder ("Photos/2024/a.jpg"), or just its name.
export type TFile = { path: string; size: number; type: string; modified: number; done: number; state: FileState; saved?: Saved };
export type BatchState = "asking" | "incoming" | "active" | "done" | "declined" | "cancelled" | "failed";
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
};
export type Caps = { ios: boolean; sink: SinkKind; room?: number };

const READ_BLOCK = 2 * 1024 ** 2;  // read from disk 2 MB at a time
const HIGH = 8 * 1024 ** 2;        // most bytes waiting in the connection's own buffer
const WINDOW = 16 * 1024 ** 2;     // most bytes sent but not yet written on the other side
const ACK_EVERY = 1024 ** 2;
export const MAX_FILES = 10_000;
const MAX_SIZE = 2 ** 50;

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class Transfers {
  batches: Batch[] = [];
  remote: Caps | null = null;
  private peer: PeerLink | null = null;
  private outFiles = new Map<string, File[]>();
  private sinks = new Map<string, Sink>();
  private zips = new Map<string, ZipBatch>();
  private stops = new Map<string, () => void>();  // stops what a batch is doing right now
  private sending: Promise<void> = Promise.resolve();
  private samples = new Map<string, { at: number; done: number }>();

  constructor(private changed: () => void) {}

  // A new direct connection. Anything that was on the way over the old one has failed.
  attach(peer: PeerLink) {
    if (this.peer === peer) return;
    this.detach("The connection dropped");
    this.peer = peer;
    void this.sayHello();
  }

  detach(why: string) {
    this.peer = null;
    this.remote = null;
    for (const b of this.batches) if (b.state === "asking" || b.state === "incoming" || b.state === "active") this.stop(b, "failed", why);
    this.changed();
  }

  private async sayHello() {
    const peer = this.peer;
    const sink = sinkKind();
    const caps: Caps = { ios: isIOS(), sink, room: sink === "browser" ? await browserRoom() : undefined };
    peer?.send({ t: "hello", ...caps });
  }

  // Answers true when the control message was about files.
  handle(m: Record<string, unknown>): boolean {
    switch (m.t) {
      case "hello":
        this.remote = { ios: m.ios === true, sink: m.sink as SinkKind, room: typeof m.room === "number" ? m.room : undefined };
        this.changed();
        return true;
      case "offer": this.offered(m); return true;
      case "accept": {
        const b = this.find(m.id, true);
        if (b?.state === "asking") { b.state = "active"; this.changed(); this.queue(b); }
        return true;
      }
      case "decline": {
        const b = this.find(m.id, true);
        if (b?.state === "asking") { b.state = "declined"; this.outFiles.delete(b.id); this.changed(); }
        return true;
      }
      case "cancel": {
        const b = this.find(m.id, true) ?? this.find(m.id, false);
        if (b && (b.state === "asking" || b.state === "incoming" || b.state === "active")) this.stop(b, "cancelled");
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
    if (!b || !(b.state === "asking" || b.state === "incoming" || b.state === "active")) return;
    this.stop(b, "cancelled");
    this.peer?.send({ t: "cancel", id });
  }

  // A data channel the other device opened: one file of a batch this device accepted.
  channel(ch: RTCDataChannel) {
    const m = /^f:([a-z0-9]+):(\d+)$/.exec(ch.label);
    const b = m && this.find(m[1], false);
    const i = m ? Number(m[2]) : -1;
    const sink = b && this.sinks.get(b.id);
    if (!b || !sink || b.state !== "active" || i >= b.files.length) return ch.close();
    this.receive(b, i, sink, ch);
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
    this.batches.push({
      id: m.id, out: false, files, total: files.reduce((s, f) => s + f.size, 0), done: 0, state: "incoming", speed: 0,
      folder: files.some((f) => f.path.includes("/")),
    });
    this.changed();
  }

  private find(id: unknown, out: boolean) {
    return this.batches.find((b) => b.id === id && b.out === out);
  }

  private stop(b: Batch, state: BatchState, why?: string) {
    b.state = state;
    if (why) b.error = why;
    this.stops.get(b.id)?.();
    this.stops.delete(b.id);
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
    if (b.state !== "active") return;
    b.state = "done";
    b.done = b.total;
    this.stops.delete(b.id);
    this.outFiles.delete(b.id);
    this.sinks.delete(b.id);
    this.zips.delete(b.id);
    this.changed();
  }

  // Batches go out one at a time, so a second one doesn't halve the speed of the first.
  private queue(b: Batch) {
    this.sending = this.sending.then(() => this.send(b)).catch(() => {});
  }

  private async send(b: Batch) {
    const files = this.outFiles.get(b.id);
    if (!files || b.state !== "active") return;
    try {
      for (let i = 0; i < files.length; i++) {
        if (b.state !== "active") return;
        b.files[i].state = "moving";
        await this.sendFile(b, i, files[i]);
        b.files[i].state = "done";
        b.files[i].done = files[i].size;
        this.progress(b);
      }
      this.finished(b);
    } catch (e) {
      if (b.state === "active") {
        this.stop(b, "failed", reason(e));
        this.peer?.send({ t: "cancel", id: b.id });
      }
    }
  }

  private async sendFile(b: Batch, i: number, file: File) {
    const peer = this.peer;
    if (!peer) throw new Error("The connection dropped");
    const f = b.files[i];
    const ch = peer.openChannel(`f:${b.id}:${i}`);
    ch.binaryType = "arraybuffer";
    ch.bufferedAmountLowThreshold = HIGH / 4;
    let acked = 0, sent = 0, broken: string | null = null;
    let wake: (() => void) | null = null;
    const nudge = () => { const w = wake; wake = null; w?.(); };
    let answered: (v: string | null) => void;
    const answer = new Promise<string | null>((r) => { answered = r; });
    ch.onbufferedamountlow = nudge;
    ch.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      if (e.data.startsWith("ack:")) {
        acked = Math.max(acked, Number(e.data.slice(4)) || 0);
        f.done = Math.min(acked, f.size);
        this.progress(b);
        nudge();
      } else if (e.data === "done") answered(null);
      else if (e.data.startsWith("err:")) { broken = e.data.slice(4) || "The other device couldn't save the file"; answered(broken); nudge(); }
    };
    ch.onclose = () => { broken ??= "The connection dropped"; answered(broken); nudge(); };
    this.stops.set(b.id, () => { broken ??= "Cancelled"; ch.close(); nudge(); });

    await new Promise<void>((ok) => {
      if (ch.readyState === "open") return ok();
      ch.onopen = () => ok();
      const was = ch.onclose;
      ch.onclose = (ev) => { (was as (e: Event) => void)?.(ev); ok(); };
    });
    const piece = peer.chunkSize;
    while (sent < file.size) {
      if (broken) throw new Error(broken);
      const end = Math.min(file.size, sent + READ_BLOCK);
      let block: Uint8Array<ArrayBuffer>;
      try {
        block = new Uint8Array(await file.slice(sent, end).arrayBuffer());
      } catch {
        throw new Error(`Couldn't read “${f.path}”. Was it moved or deleted?`);
      }
      for (let o = 0; o < block.length; o += piece) {
        while (!broken && (ch.bufferedAmount > HIGH || sent + o - acked > WINDOW)) await new Promise<void>((r) => { wake = r; });
        if (broken) throw new Error(broken);
        ch.send(block.subarray(o, Math.min(block.length, o + piece)));
      }
      sent = end;
    }
    if (broken) throw new Error(broken);
    ch.send("end");
    const err = await answer;
    if (err) throw new Error(err);
    ch.onclose = null;
    ch.close();
  }

  private receive(b: Batch, i: number, sink: Sink, ch: RTCDataChannel) {
    ch.binaryType = "arraybuffer";
    const f = b.files[i];
    f.state = "moving";
    let writer: FileWriter | null = null, received = 0, written = 0, lastAck = 0, over = false;
    const zip = this.zips.get(b.id);
    let chain: Promise<void> = (zip ? Promise.resolve(zip.entry(i)) : sink.open(f.path, f.size, f.type)).then((w) => { writer = w; });
    const fail = (why: string, tell = true) => {
      if (over) return;
      over = true;
      f.state = "failed";
      void (writer as FileWriter | null)?.abort();
      if (tell && ch.readyState === "open") ch.send("err:" + why);
      if (b.state === "active") this.stop(b, "failed", why);
    };
    this.stops.set(b.id, () => { if (!over) { over = true; f.state = "failed"; void (writer as FileWriter | null)?.abort(); } ch.close(); });
    const step = (fn: () => Promise<void>) => {
      chain = chain.then(() => (over ? undefined : fn())).catch((e) => fail(reason(e)));
    };
    ch.onmessage = (e) => {
      if (over) return;
      if (typeof e.data === "string") {
        if (e.data === "end") step(async () => {
          if (received !== f.size) throw new Error("The file arrived incomplete");
          f.saved = await writer!.close();
          over = true;
          f.state = "done";
          f.done = f.size;
          ch.send("ack:" + written);
          ch.send("done");
          this.progress(b);
          this.finished(b);
        });
        return;
      }
      const buf = e.data as ArrayBuffer, len = buf.byteLength;
      received += len;
      if (received > f.size) return fail("More data arrived than was offered");
      step(async () => {
        await writer!.write(buf);
        written += len;
        f.done = written;
        if (written - lastAck >= ACK_EVERY) { lastAck = written; ch.send("ack:" + written); }
        this.progress(b);
      });
    };
    ch.onclose = () => { if (!over) fail("The connection dropped", false); };
  }
}
