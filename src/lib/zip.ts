// A received folder, packed into one .zip as it arrives, for devices that can only save single files.
// No compression (photos and videos don't shrink, and it keeps 20 GB fast); zips over 4 GB use Zip64.
import { makeZip, predictLength } from "client-zip";
import type { FileWriter, Saved } from "./sinks";

export type ZipFile = { path: string; size: number; modified: number };

const when = (ms: number) => new Date(Number.isFinite(ms) && ms > 0 ? ms : Date.now());

export function zipLength(files: ZipFile[]): number {
  return Number(predictLength(files.map((f) => ({ name: f.path, size: f.size, lastModified: when(f.modified) }))));
}

// "Photos/a.jpg", "Photos/b.jpg" → "Photos.zip"; anything else → "Files from <device>.zip".
export function zipName(files: ZipFile[], from: string): string {
  const tops = new Set(files.map((f) => f.path.split("/")[0]));
  const one = tops.size === 1 && files.every((f) => f.path.includes("/"));
  return (one ? [...tops][0] : `Files from ${from}`.replace(/[<>:"/\\|?*]/g, "_")) + ".zip";
}

type Entry = { stream: ReadableStream<Uint8Array>; writer: FileWriter };

export class ZipBatch {
  readonly done: Promise<Saved>;
  private entries = new Map<number, Entry>();
  private broken: Error | null = null;

  constructor(private files: ZipFile[], out: FileWriter) {
    this.done = this.pump(makeZip(this.inputs()), out);
    this.done.catch(() => {});
  }

  // The file at this place in the batch, to be written into the zip as it arrives.
  entry(i: number): FileWriter {
    return this.get(i).writer;
  }

  abort(why: string) {
    this.broken ??= new Error(why);
    for (const e of this.entries.values()) void e.writer.abort();
  }

  private async *inputs() {
    for (let i = 0; i < this.files.length; i++) {
      const f = this.files[i];
      yield { name: f.path, size: f.size, lastModified: when(f.modified), input: this.get(i).stream };
    }
  }

  private async pump(zip: ReadableStream<Uint8Array>, out: FileWriter): Promise<Saved> {
    const reader = zip.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.broken) throw this.broken;
        // A copy, because the writer may hand the buffer over to another thread.
        await out.write(value.slice().buffer);
      }
      return await out.close();
    } catch (e) {
      await out.abort();
      throw this.broken ?? e;
    }
  }

  // Each file is a stream the zip reads from. A piece is handed over only when the zip asks for one,
  // so at most a few pieces wait in memory.
  private get(i: number): Entry {
    let e = this.entries.get(i);
    if (e) return e;
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let asked = 0, closed = false;
    let wake: (() => void) | null = null;
    const nudge = () => { const w = wake; wake = null; w?.(); };
    const stream = new ReadableStream<Uint8Array>(
      { start(c) { controller = c; }, pull() { asked++; nudge(); } },
      new CountQueuingStrategy({ highWaterMark: 4 }),
    );
    const writer: FileWriter = {
      write: async (b) => {
        while (!asked && !this.broken) await new Promise<void>((r) => { wake = r; });
        if (this.broken) throw this.broken;
        asked--;
        controller.enqueue(new Uint8Array(b));
      },
      close: async () => {
        if (!closed) { closed = true; controller.close(); }
        return { kind: "zipped" };
      },
      abort: async () => {
        this.broken ??= new Error("Cancelled");
        nudge();
        if (!closed) { closed = true; controller.error(this.broken); }
      },
    };
    e = { stream, writer };
    this.entries.set(i, e);
    return e;
  }
}
