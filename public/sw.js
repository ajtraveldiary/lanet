// Turns a file arriving from another device into a normal browser download, written to disk as it arrives,
// so even a 20 GB file never has to fit in memory. Nothing is cached; this worker only answers /__download/.

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
  if (url.origin !== self.location.origin || !url.pathname.startsWith("/__download/")) return;
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
