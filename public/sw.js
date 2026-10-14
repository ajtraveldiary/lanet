// Two jobs, nothing cached:
// 1. /__download/… : turns a file arriving from another device into a normal browser download, written to
//    disk as it arrives, so even a 20 GB file never has to fit in memory.
// 2. POST /share-target : takes in files, text or a link shared to Lanet from another app (Android, Lanet
//    installed). They are kept in the browser's own storage on this device (lanet-shared/<id>/), never sent
//    anywhere, until the person sends or removes them; then Lanet opens and offers to send them.

const waiting = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.type !== "download" || !e.ports[0]) return;
  const port = e.ports[0];
  const stream = new ReadableStream(
    {
      start(controller) {
        port.onmessage = ({ data }) => {
          if (data === "end") controller.close();
          else if (data === "abort") controller.error(new Error("Cancelled"));
          else if (data instanceof ArrayBuffer) controller.enqueue(new Uint8Array(data));
        };
      },
      // The page sends the next piece only when asked, so pieces never pile up here.
      pull() { port.postMessage("pull"); },
      cancel() { port.postMessage("cancelled"); },
    },
    new CountQueuingStrategy({ highWaterMark: 8 }),
  );
  waiting.set(String(d.id), { stream, name: String(d.name), size: Number(d.size) });
  port.postMessage("ready");
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === "/share-target" && e.request.method === "POST") return e.respondWith(takeShared(e.request));
  if (!url.pathname.startsWith("/__download/")) return;
  const id = url.pathname.slice("/__download/".length);
  const item = waiting.get(id);
  if (!item) return e.respondWith(new Response("This download has expired.", { status: 404 }));
  waiting.delete(id);
  const headers = new Headers({
    "Content-Type": "application/octet-stream",
    "Content-Disposition": "attachment; filename*=UTF-8''" + encodeURIComponent(item.name),
    "X-Content-Type-Options": "nosniff",
  });
  if (Number.isFinite(item.size)) headers.set("Content-Length", String(item.size));
  e.respondWith(new Response(item.stream, { headers }));
});

// Names stay as the other app gave them, minus anything that isn't allowed in a file name.
const cleanName = (n) => String(n || "file").replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_").slice(0, 200) || "file";

async function takeShared(request) {
  try {
    const form = await request.formData();
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const root = await navigator.storage.getDirectory();
    const shared = await root.getDirectoryHandle("lanet-shared", { create: true });
    const set = await shared.getDirectoryHandle(id, { create: true });
    const files = await set.getDirectoryHandle("files", { create: true });
    const used = new Set();
    for (const f of form.getAll("files")) {
      if (!(f instanceof File) || (!f.size && !f.name)) continue;
      let name = cleanName(f.name), n = 2;
      const dot = name.lastIndexOf(".");
      while (used.has(name)) name = dot > 0 ? `${name.slice(0, dot)} (${n++})${name.slice(dot)}` : `${name} (${n++})`;
      used.add(name);
      const w = await (await files.getFileHandle(name, { create: true })).createWritable();
      // Streamed to disk, so a long video never has to fit in memory.
      await f.stream().pipeTo(w);
    }
    // Apps often repeat the link in "text" and "url"; each line is kept once.
    const lines = ["title", "text", "url"].map((k) => form.get(k)).filter((v) => typeof v === "string" && v.trim()).map((v) => v.trim());
    const text = [...new Set(lines)].join("\n");
    // Written last: a set without it is still arriving, and the page leaves it alone.
    const meta = await (await set.getFileHandle("meta.json", { create: true })).createWritable();
    await meta.write(JSON.stringify({ at: Date.now(), text: text.slice(0, 100000) }));
    await meta.close();
  } catch {
    // Nothing kept; Lanet still opens.
  }
  return Response.redirect("/?shared=1", 303);
}
