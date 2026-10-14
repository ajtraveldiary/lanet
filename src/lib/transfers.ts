// Sending and receiving files with one other device over the direct connection.
//
// The sender offers a batch of files on the control channel; nothing moves until the receiver accepts.
// Each file then gets its own data channel, labelled "f:<batch>:<file>:<starting byte>:<slot>:<slots>":
// binary pieces, then "end". The receiver answers on slot 0 with "ack:<bytes written>" every so often and
// "done" (or "err:<reason>") at the end. The sender never runs more than WINDOW bytes ahead of what the
// receiver has written, so a slow disk can't fill memory.
//
// Faster on two counts. Up to PARALLEL smaller files move side by side. A big file is cut into 1 MB blocks
// dealt round-robin over up to three connections between the same two devices (the main one and two extra
// "lanes"): slot k carries blocks k, k + slots, k + 2·slots… of the file from its starting byte, in order, so
// the receiver knows where every piece belongs and puts them back in order before writing.
//
// A dropped connection pauses a batch instead of failing it: both sides keep what they have (files being
// written stay open). When the main connection comes back, each side says which batches it still has
// ("hello"), and the receiver asks for the rest of each paused one ("resume", with each unfinished file and
// the byte it got to). If only a file's channel or an extra lane dropped, the receiver asks straight away.
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
export type Caps = { ios: boolean; sink: SinkKind; room?: number; v?: number };

// Both devices must speak the same version of this protocol; a page left open across an update doesn't.
export const PROTOCOL = 2;

const HIGH = 8 * 1024 ** 2;        // most bytes waiting in one channel's own buffer
const WINDOW = 32 * 1024 ** 2;     // most bytes sent but not yet written on the other side, per file
const GROUP = 4 * 1024 ** 2;       // the receiver writes in groups of this size
const BLOCK = 1024 ** 2;           // a big file is dealt across connections in blocks of this size
const STRIPE_MIN = 32 * 1024 ** 2; // files (or what's left of them) from this size use every connection
const PARALLEL = 4;                // smaller files moving at the same time
const MAX_SLOTS = 3;               // the main connection and two extra lanes
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

// Which files still need sending, and from which byte: [file, byte][].
type Plan = [number, number][];

// The receiver's place in one file. Kept through a dropped connection, so the file stays open and the rest
// can be appended. `next` is the first byte not yet in order; pieces that arrived early wait in `early`.
type Session = { start: number; slots: number; pos: number[]; ends: number; seen: Set<number>; chans: RTCDataChannel[]; ack: RTCDataChannel | null };
type Rx = {
  writer: FileWriter | null;
  written: number;
  next: number;
  chain: Promise<void>;
  session: Session | null;
  early: Map<number, ArrayBuffer>;
  earlyBytes: number;
  group: ArrayBuffer[];
  grouped: number;
};

export class Transfers {
  batches: Batch[] = [];
  remote: Caps | null = null;
  private peer: PeerLink | null = null;
  private lanes: (PeerLink | null)[] = [null, null, null];  // [unused, lane 1, lane 2]
  private outFiles = new Map<string, File[]>();
  private sinks = new Map<string, Sink>();
  private zips = new Map<string, ZipBatch>();
  private rx = new Map<string, Map<number, Rx>>();
  private halts = new Map<string, Set<() => void>>();  // close the channels a batch is using right now
  private gen = new Map<string, number>();  // bumps whenever sending (re)starts, so an older run stands down
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

  // An extra connection to the same device came up (peer) or went (null). Big files use whichever are up.
  setLane(k: number, peer: PeerLink | null) {
    if (k === 1 || k === 2) this.lanes[k] = peer;
  }

  // The room has closed, or this device is gone for good: nothing can continue.
  end(why: string) {
    this.peer = null;
    for (const b of this.batches) if (isOpen(b)) this.stop(b, "failed", why);
    this.changed();
  }

  // The other device runs a different version of Lanet (a page left open across an update).
  get mismatch(): boolean {
    return !!this.remote && this.remote.v !== PROTOCOL;
  }

  private async sayHello() {
    const peer = this.peer;
    const sink = sinkKind();
    const room = sink === "browser" ? await browserRoom() : undefined;
    // Which batches this side still has, so the other side can tell what to resume and what was lost.
    const open = this.batches.filter((b) => isOpen(b) && !b.orphan).map((b) => b.id);
    const done = this.batches.filter((b) => b.state === "done").map((b) => b.id);
    peer?.send({ t: "hello", v: PROTOCOL, ios: isIOS(), sink, room, open, done });
  }

  // Answers true when the control message was about files.
  handle(m: Record<string, unknown>): boolean {
    switch (m.t) {
      case "hello": this.hello(m); return true;
      case "offer": if (!this.mismatch) this.offered(m); return true;
      case "accept": {
        const b = this.find(m.id, true);
        if (b?.state === "asking") this.startFrom(b, m.files, m.parallel);
        return true;
      }
      case "resume": {
        const b = this.find(m.id, true);
        if (b && (b.state === "paused" || b.state === "active")) this.startFrom(b, m.files, m.parallel);
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

  // The new batch's id, or null when it couldn't be offered (not connected, or a different version).
  offer(picked: Picked[]): string | null {
    if (this.mismatch) return null;
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
    if (!this.peer?.send({ t: "offer", id: b.id, files: list })) return null;
    this.outFiles.set(b.id, picked.map((p) => p.file));
    this.batches.push(b);
    this.changed();
    return b.id;
  }

  // From a click: picking a folder or asking for permission needs one.
  // `from` names the sending device, for the .zip's name when a folder has to be packed.
  async accept(id: string, from: string): Promise<string | null> {
    const b = this.find(id, false);
    if (b?.state !== "incoming") return null;
    if (this.mismatch) return MISMATCH;
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
    if (zip) this.zips.set(id, zip);
    if (b.state !== "incoming" || !this.peer?.send({ t: "accept", id, files: this.plan(b), parallel: this.parallel(b) })) {
      zip?.abort("Cancelled");
      this.zips.delete(id);
      return b.state === "incoming" ? "Not connected right now. Try again in a moment." : null;
    }
    this.sinks.set(id, sink);
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

  // A data channel the other device opened: one slot of one file of a batch this device accepted.
  channel(ch: RTCDataChannel) {
    const m = /^f:([a-z0-9]+):(\d+):(\d+):(\d+):(\d+)$/.exec(ch.label);
    const b = m && this.find(m[1], false);
    const [i, start, slot, slots] = m ? [m[2], m[3], m[4], m[5]].map(Number) : [-1, -1, -1, -1];
    if (!b || !this.sinks.has(b.id) || b.state !== "active" || i >= b.files.length) return ch.close();
    if (slots < 1 || slots > MAX_SLOTS || slot >= slots || start > b.files[i].size) return ch.close();
    this.receive(b, i, start, slot, slots, ch);
  }

  private hello(m: Record<string, unknown>) {
    this.remote = { ios: m.ios === true, sink: m.sink as SinkKind, room: typeof m.room === "number" ? m.room : undefined, v: typeof m.v === "number" ? m.v : undefined };
    if (this.mismatch) { this.changed(); return; }
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

  // Accepting an offer that continues a paused batch: it takes over that batch's place, its open files
  // and their half-written data, and asks for the rest only.
  private async carryOn(b: Batch, old: Batch): Promise<string | null> {
    await this.drained(old.id);
    if (!this.peer) return "Not connected right now. Try again in a moment.";
    b.files.forEach((f, k) => Object.assign(f, { done: old.files[k].done, state: old.files[k].state, saved: old.files[k].saved }));
    b.where = old.where;
    b.zip = old.zip;
    for (const map of [this.sinks, this.zips, this.rx] as Map<string, unknown>[]) {
      if (map.has(old.id)) { map.set(b.id, map.get(old.id)); map.delete(old.id); }
    }
    this.batches = this.batches.filter((x) => x !== old);
    b.continues = undefined;
    b.state = "active";
    this.progress(b);
    this.peer.send({ t: "accept", id: b.id, files: this.plan(b), parallel: this.parallel(b) });
    return null;
  }

  // What the receiver still needs: every unfinished file, from the byte written so far.
  private plan(b: Batch): Plan {
    const rx = this.rx.get(b.id);
    return b.files.flatMap((f, i): Plan => (f.state === "done" ? [] : [[i, rx?.get(i)?.written ?? 0]]));
  }

  // A folder packed into a .zip must arrive in order, one file at a time.
  private parallel(b: Batch) {
    return this.zips.has(b.id) ? 1 : PARALLEL;
  }

  // Everything that arrived before a drop is written before the receiver says where it got to.
  private async drained(id: string) {
    await Promise.all([...(this.rx.get(id)?.values() ?? [])].map((r) => r.chain));
  }

  private async askToResume(b: Batch) {
    await this.drained(b.id);
    if (b.state !== "paused" || b.orphan || !this.peer) return;
    // If the request can't go now, the batch stays paused; the next connection's "hello" asks again.
    if (!this.peer.send({ t: "resume", id: b.id, files: this.plan(b), parallel: this.parallel(b) })) return;
    b.state = "active";
    this.samples.delete(b.id);
    this.changed();
  }

  private find(id: unknown, out: boolean) {
    return this.batches.find((b) => b.id === id && b.out === out);
  }

  private addHalt(id: string, fn: () => void) {
    const set = this.halts.get(id) ?? new Set();
    set.add(fn);
    this.halts.set(id, set);
    return () => set.delete(fn);
  }

  private haltAll(id: string) {
    const set = this.halts.get(id);
    this.halts.delete(id);
    for (const fn of set ?? []) fn();
  }

  private pause(b: Batch) {
    if (b.state !== "active") return;
    b.state = "paused";
    b.speed = 0;
    this.samples.delete(b.id);
    this.haltAll(b.id);
    // Only a file's channel or an extra lane went, while the main connection is still up:
    // the receiver asks for the rest straight away instead of waiting for a reconnect.
    if (!b.out && this.peer) setTimeout(() => void this.askToResume(b), 500);
    this.changed();
  }

  private stop(b: Batch, state: BatchState, why?: string) {
    b.state = state;
    if (why) b.error = why;
    b.orphan = undefined;
    this.haltAll(b.id);
    for (const [i, r] of this.rx.get(b.id) ?? []) {
      if (b.files[i].state !== "done") { b.files[i].state = "failed"; void r.writer?.abort(); }
    }
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

  // The receiver accepted (or asked for the rest): send what it still needs.
  private startFrom(b: Batch, list: unknown, parallel: unknown) {
    const files = this.outFiles.get(b.id);
    const plan: Plan = [];
    const ok = !!files && Array.isArray(list) && list.every((e) => {
      const [i, at] = Array.isArray(e) ? e.map(Number) : [NaN, NaN];
      if (!Number.isInteger(i) || i < 0 || i >= files.length || !Number.isSafeInteger(at) || at < 0 || at > files[i].size) return false;
      if (plan.some(([j]) => j === i)) return false;
      plan.push([i, at]);
      return true;
    });
    if (!ok) {
      this.stop(b, "failed", "The other device asked for a part that doesn't exist");
      this.peer?.send({ t: "cancel", id: b.id });
      return;
    }
    const wanted = new Map(plan);
    b.files.forEach((f, k) => {
      const at = wanted.get(k);
      if (at === undefined) { f.state = "done"; f.done = f.size; }
      else { f.state = "waiting"; f.done = at; }
    });
    b.state = "active";
    this.samples.delete(b.id);
    this.progress(b);
    const gen = (this.gen.get(b.id) ?? 0) + 1;
    this.gen.set(b.id, gen);
    const lanes = Math.min(Math.max(1, Number(parallel) || 1), PARALLEL);
    // Batches go out one at a time, so a second one doesn't halve the speed of the first.
    this.sending = this.sending.then(() => this.send(b, plan, lanes, gen)).catch(() => {});
  }

  private async send(b: Batch, plan: Plan, parallel: number, gen: number) {
    const files = this.outFiles.get(b.id);
    const current = () => this.gen.get(b.id) === gen && b.state === "active";
    if (!files || !current()) return;
    const one = async ([i, at]: [number, number]) => {
      b.files[i].state = "moving";
      await this.sendFile(b, i, files[i], at);
      b.files[i].state = "done";
      b.files[i].done = files[i].size;
      this.progress(b);
    };
    try {
      if (parallel <= 1) {
        for (const p of plan) { if (!current()) return; await one(p); }
      } else {
        // Smaller files first, several at a time; then each big file on its own, spread over every connection.
        const small = plan.filter(([i, at]) => files[i].size - at < STRIPE_MIN);
        const big = plan.filter(([i, at]) => files[i].size - at >= STRIPE_MIN);
        const worker = async () => { while (small.length && current()) await one(small.shift()!); };
        await Promise.all(Array.from({ length: Math.min(parallel, small.length) }, worker));
        for (const p of big) { if (!current()) return; await one(p); }
      }
      if (current()) this.finished(b);
    } catch (e) {
      if (!current()) return;
      if (e instanceof Dropped || !this.peer) return this.pause(b);
      this.stop(b, "failed", reason(e));
      this.peer?.send({ t: "cancel", id: b.id });
    }
  }

  // The connections a file can use right now: the main one, then any extra lane that's up.
  private connections(): PeerLink[] {
    const extra = this.lanes.filter((p): p is PeerLink => !!p && p.state === "connected");
    return [this.peer!, ...extra].slice(0, MAX_SLOTS);
  }

  private async sendFile(b: Batch, i: number, file: File, start: number) {
    if (!this.peer) throw new Dropped();
    const f = b.files[i];
    const peers = file.size - start >= STRIPE_MIN ? this.connections() : [this.peer];
    const slots = peers.length;
    const chans = peers.map((p, k) => p.openChannel(`f:${b.id}:${i}:${start}:${k}:${slots}`));
    let acked = start, broken: Error | null = null;
    const waiting = new Set<() => void>();
    const nudge = () => { for (const w of [...waiting]) w(); waiting.clear(); };
    let answered: (v: Error | null) => void;
    const answer = new Promise<Error | null>((r) => { answered = r; });
    const breakWith = (e: Error) => { broken ??= e; answered(broken); nudge(); };
    for (const ch of chans) {
      ch.binaryType = "arraybuffer";
      ch.bufferedAmountLowThreshold = HIGH / 4;
      ch.onbufferedamountlow = nudge;
      ch.onclose = () => breakWith(new Dropped());
    }
    chans[0].onmessage = (e) => {
      if (typeof e.data !== "string") return;
      if (e.data.startsWith("ack:")) {
        acked = Math.max(acked, Number(e.data.slice(4)) || 0);
        f.done = Math.min(acked, f.size);
        this.progress(b);
        nudge();
      } else if (e.data === "done") answered(null);
      else if (e.data.startsWith("err:")) breakWith(new Error(e.data.slice(4) || "The other device couldn't save the file"));
    };
    const unhalt = this.addHalt(b.id, () => { breakWith(new Dropped()); for (const ch of chans) ch.close(); });
    // A channel can close between two pieces, before its close event arrives.
    const put = (ch: RTCDataChannel, data: string | Uint8Array<ArrayBuffer>) => {
      if (ch.readyState !== "open") throw broken ?? new Dropped();
      ch.send(data as string);
    };
    const wait = () => new Promise<void>((r) => waiting.add(r));

    try {
      await Promise.all(chans.map((ch) => new Promise<void>((ok) => {
        if (ch.readyState === "open") return ok();
        ch.onopen = () => ok();
        void answer.then(() => ok());
      })));
      // Slot k sends blocks k, k + slots, k + 2·slots… in order; the receiver works out where each piece goes.
      await Promise.all(chans.map(async (ch, k) => {
        const piece = peers[k].chunkSize;
        for (let n = k; ; n += slots) {
          const from = start + n * BLOCK;
          if (from >= file.size) break;
          if (broken) throw broken;
          const to = Math.min(file.size, from + BLOCK);
          let block: Uint8Array<ArrayBuffer>;
          try {
            block = new Uint8Array(await file.slice(from, to).arrayBuffer());
          } catch {
            throw new Error(`Couldn't read “${f.path}”. Was it moved or deleted?`);
          }
          for (let o = 0; o < block.length; o += piece) {
            while (!broken && (ch.bufferedAmount > HIGH || from + o - acked > WINDOW)) await wait();
            if (broken) throw broken;
            put(ch, block.subarray(o, Math.min(block.length, o + piece)));
          }
        }
        if (broken) throw broken;
        put(ch, "end");
      }));
      const err = await answer;
      if (err) throw err;
    } catch (e) {
      breakWith(e instanceof Error ? e : new Error(reason(e)));
      throw broken;
    } finally {
      unhalt();
    }
    for (const ch of chans) { ch.onclose = null; ch.close(); }
  }

  private receive(b: Batch, i: number, start: number, slot: number, slots: number, ch: RTCDataChannel) {
    ch.binaryType = "arraybuffer";
    const f = b.files[i];
    const refuse = (why: string) => {
      const say = () => { ch.send("err:" + why); ch.close(); };
      if (ch.readyState === "open") say(); else ch.onopen = say;
    };
    if (f.state === "done") return ch.close();
    const files = this.rx.get(b.id) ?? new Map<number, Rx>();
    this.rx.set(b.id, files);
    let r = files.get(i);
    if (!r) {
      if (start !== 0) return refuse("The transfer got out of step. Send it again.");
      const zip = this.zips.get(b.id);
      const opened = zip ? Promise.resolve(zip.entry(i)) : this.sinks.get(b.id)!.open(f.path, f.size, f.type);
      const fresh: Rx = { writer: null, written: 0, next: 0, chain: Promise.resolve(), session: null, early: new Map(), earlyBytes: 0, group: [], grouped: 0 };
      fresh.chain = opened.then((w) => { fresh.writer = w; });
      files.set(i, fresh);
      r = fresh;
    }
    const rx = r;
    // The first channel of a new start (an accept or a resume) begins a session; the others join it.
    if (!rx.session || rx.session.start !== start || rx.session.slots !== slots) {
      if (start !== rx.written) return refuse("The transfer got out of step. Send it again.");
      for (const c of rx.session?.chans ?? []) c.close();
      rx.session = { start, slots, pos: new Array(slots).fill(0), ends: 0, seen: new Set(), chans: [], ack: null };
      rx.next = start;
      rx.early.clear();
      rx.earlyBytes = 0;
      rx.group = [];
      rx.grouped = 0;
    }
    const s = rx.session;
    if (s.seen.has(slot)) return refuse("The transfer got out of step. Send it again.");
    s.seen.add(slot);
    s.chans.push(ch);
    if (slot === 0) s.ack = ch;
    f.state = "moving";

    let over = false, lastAck = rx.written;
    // Receipts go on slot 0; into a channel that just closed they're dropped, and the drop is handled by onclose.
    const tell = (msg: string) => { if (s.ack?.readyState === "open") s.ack.send(msg); };
    const fail = (why: string) => {
      if (over || b.state !== "active") return;
      over = true;
      tell("err:" + why);
      this.stop(b, "failed", why);
    };
    const step = (fn: () => Promise<void>) => {
      rx.chain = rx.chain.then(() => (rx.session === s && b.state === "active" ? fn() : undefined)).catch((e) => fail(reason(e)));
    };
    const unhalt = this.addHalt(b.id, () => { over = true; ch.close(); });
    // Pieces are written in groups of about 4 MB: far fewer writes for the disk, the storage worker or the
    // download. Anything not yet written when a connection drops is simply sent again on resume.
    const flush = () => {
      if (!rx.grouped) return;
      const parts = rx.group, n = rx.grouped;
      rx.group = [];
      rx.grouped = 0;
      step(async () => {
        await rx.writer!.write(parts.length === 1 ? parts[0] : join(parts, n));
        rx.written += n;
        f.done = rx.written;
        if (rx.written - lastAck >= ACK_EVERY) { lastAck = rx.written; tell("ack:" + rx.written); }
        this.progress(b);
      });
    };
    const settle = () => {
      while (rx.early.has(rx.next)) {
        const buf = rx.early.get(rx.next)!;
        rx.early.delete(rx.next);
        rx.earlyBytes -= buf.byteLength;
        rx.group.push(buf);
        rx.grouped += buf.byteLength;
        rx.next += buf.byteLength;
        if (rx.grouped >= GROUP) flush();
      }
    };
    ch.onmessage = (e) => {
      if (over || rx.session !== s) return;
      if (typeof e.data === "string") {
        if (e.data !== "end") return;
        s.ends++;
        if (s.ends < s.slots) return;
        settle();
        flush();
        step(async () => {
          if (rx.next !== f.size || rx.early.size) throw new Error("The file arrived incomplete");
          f.saved = await rx.writer!.close();
          over = true;
          f.state = "done";
          f.done = f.size;
          tell("ack:" + rx.written);
          tell("done");
          files.delete(i);
          this.progress(b);
          this.finished(b);
        });
        return;
      }
      const buf = e.data as ArrayBuffer, len = buf.byteLength;
      // Where this piece belongs: this slot's p-th byte lies in block (p / BLOCK)·slots + slot.
      const p = s.pos[slot];
      if ((p % BLOCK) + len > BLOCK) return fail("The transfer got out of step. Send it again.");
      const at = start + (Math.floor(p / BLOCK) * slots + slot) * BLOCK + (p % BLOCK);
      s.pos[slot] += len;
      if (at + len > f.size) return fail("More data arrived than was offered");
      rx.early.set(at, buf);
      rx.earlyBytes += len;
      if (rx.earlyBytes > WINDOW + BLOCK * MAX_SLOTS) return fail("The transfer got out of step. Send it again.");
      settle();
    };
    // A connection went: keep the file open and wait for it to come back.
    ch.onclose = () => {
      unhalt();
      if (!over && f.state !== "done" && rx.session === s) { over = true; this.pause(b); }
    };
  }
}

export const MISMATCH = "The other device is running a different version of Lanet. Reload the page on both devices, then try again.";

function join(parts: ArrayBuffer[], size: number): ArrayBuffer {
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) { out.set(new Uint8Array(p), at); at += p.byteLength; }
  return out.buffer;
}

function sameFiles(a: TFile[], b: TFile[]): boolean {
  return a.length === b.length && a.every((f, k) => f.path === b[k].path && f.size === b[k].size && f.modified === b[k].modified);
}
