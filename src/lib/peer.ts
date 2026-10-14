// The direct connection between the main device and one other device (WebRTC).
// The room only carries the setup messages; everything sent after that goes device to device.

export type LinkState = "connecting" | "connected" | "reconnecting" | "blocked";
// `lane` picks one of the extra connections between the same two devices (1 or 2); none means the main one.
export type Signal = { sdp?: RTCSessionDescriptionInit; ice?: RTCIceCandidateInit; restart?: true; lane?: number };

const CONNECT_TIMEOUT = 15_000;
// Messages bigger than this go in parts. Kept small enough that a part stays under 64 KB,
// the most every browser accepts in one message, even when every character takes 3 bytes.
const PART = 16_000;
const MAX_PARTS = 1000;

export function randomKey(): string {
  // Not crypto.randomUUID: it is missing on plain-http pages, which is how the app is tried on a home network.
  return [...crypto.getRandomValues(new Uint8Array(9))].map((b) => b.toString(36).padStart(2, "0")).join("");
}

type Options = {
  offerer: boolean;
  signal: (s: Signal) => void;
  onState: (s: LinkState) => void;
  onMessage: (m: Record<string, unknown>) => void;
  onChannel: (ch: RTCDataChannel) => void;  // any channel other than the control one (one per file)
};

const MAX_PIECE = 256 * 1024;

export class PeerLink {
  state: LinkState = "connecting";
  private pc: RTCPeerConnection;
  private ctl: RTCDataChannel | null = null;
  private steps: Promise<void> = Promise.resolve();
  private timer: number;
  private closed = false;
  private parts = new Map<string, string[]>();

  constructor(private o: Options) {
    // No STUN or TURN servers: only addresses on the local network are offered, so nothing can leave it.
    this.pc = new RTCPeerConnection({ iceServers: [] });
    this.pc.onicecandidate = (e) => {
      if (e.candidate?.candidate) o.signal({ ice: e.candidate.toJSON() });
    };
    this.pc.onconnectionstatechange = () => {
      const s = this.pc.connectionState;
      if (s === "failed") this.set(this.state === "connecting" ? "blocked" : "reconnecting");
      else if (s === "disconnected" && this.state === "connected") this.set("reconnecting");
    };
    this.pc.ondatachannel = (e) => {
      if (e.channel.label === "ctl") { if (!o.offerer) this.useChannel(e.channel); }
      else o.onChannel(e.channel);
    };
    if (o.offerer) {
      this.useChannel(this.pc.createDataChannel("ctl", { ordered: true }));
      this.steps = this.steps.then(async () => {
        await this.pc.setLocalDescription(await this.pc.createOffer());
        o.signal({ sdp: this.pc.localDescription!.toJSON() });
      }).catch(() => this.set("blocked"));
    }
    this.timer = window.setTimeout(() => { if (this.state === "connecting") this.set("blocked"); }, CONNECT_TIMEOUT);
  }

  // Setup messages are handled one at a time, so an address never arrives before the offer it belongs to.
  handle(s: Signal) {
    this.steps = this.steps.then(async () => {
      if (this.closed) return;
      if (s.sdp) {
        await this.pc.setRemoteDescription(s.sdp);
        if (s.sdp.type === "offer") {
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          this.o.signal({ sdp: this.pc.localDescription!.toJSON() });
        }
      } else if (s.ice) {
        await this.pc.addIceCandidate(s.ice).catch(() => {});
      }
    }).catch(() => {});
  }

  send(msg: Record<string, unknown>): boolean {
    const ch = this.ctl;
    if (!ch || ch.readyState !== "open") return false;
    const text = JSON.stringify(msg);
    if (text.length <= PART) {
      ch.send(text);
    } else {
      const id = randomKey(), n = Math.ceil(text.length / PART);
      for (let i = 0; i < n; i++) ch.send(JSON.stringify({ t: "part", id, i, n, s: text.slice(i * PART, (i + 1) * PART) }));
    }
    return true;
  }

  openChannel(label: string): RTCDataChannel {
    return this.pc.createDataChannel(label, { ordered: true });
  }

  // The biggest piece both browsers accept in one message (they agree on it while connecting).
  get chunkSize(): number {
    const max = this.pc.sctp?.maxMessageSize;
    return Math.min(max && max > 0 ? max : 64 * 1024, MAX_PIECE);
  }

  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.ctl?.close();
    this.pc.close();
  }

  private useChannel(ch: RTCDataChannel) {
    this.ctl = ch;
    ch.onopen = () => {
      clearTimeout(this.timer);
      this.set("connected");
    };
    ch.onclose = () => { if (!this.closed) this.set("reconnecting"); };
    ch.onmessage = (e) => {
      if (typeof e.data !== "string") return;
      let m: Record<string, unknown>;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m && typeof m === "object") this.receive(m);
    };
  }

  private receive(m: Record<string, unknown>) {
    if (m.t !== "part") return this.o.onMessage(m);
    const { id, i, n, s } = m;
    if (typeof id !== "string" || typeof s !== "string" || !Number.isInteger(i) || !Number.isInteger(n)) return;
    const count = n as number, at = i as number;
    if (count < 1 || count > MAX_PARTS || at < 0 || at >= count) return;
    const got = this.parts.get(id) ?? new Array<string>(count);
    got[at] = s;
    this.parts.set(id, got);
    if (got.filter((x) => x !== undefined).length < count) return;
    this.parts.delete(id);
    try { this.receive(JSON.parse(got.join(""))); } catch { /* broken message, dropped */ }
  }

  private set(s: LinkState) {
    if (this.closed || this.state === s) return;
    this.state = s;
    this.o.onState(s);
  }
}
