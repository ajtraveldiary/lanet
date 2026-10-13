import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { Button, Note } from "./ui";
import { MAX_TEXT, type ChatMsg } from "./lib/chat";

export function Conversation({ messages, canSend, onSend, otherName }: {
  messages: ChatMsg[];
  canSend: boolean;
  onSend: (body: string) => boolean;
  otherName: string;
}) {
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  const send = () => {
    if (!draft.trim()) return;
    if (draft.length > MAX_TEXT) return setProblem(`That's longer than ${MAX_TEXT.toLocaleString()} characters. Send it as a file instead.`);
    if (!onSend(draft)) return setProblem("Not connected right now. Try again in a moment.");
    setProblem(null);
    setDraft("");
  };
  // Enter makes a new line (phones have no other way); Ctrl or ⌘ + Enter sends.
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {messages.length > 0 ? (
        <ol ref={listRef} className="flex max-h-96 flex-col gap-2 overflow-y-auto" aria-label={`Messages with ${otherName}`}>
          {messages.map((m) => <Bubble key={(m.mine ? "me" : "them") + m.id} m={m} />)}
        </ol>
      ) : (
        <p className="text-sm text-muted">Text and links you send appear here, ready to copy on the other device.</p>
      )}
      <div className="flex flex-col gap-2">
        <label htmlFor="draft" className="sr-only">Text or link to send</label>
        <textarea
          id="draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          rows={3}
          placeholder="Type or paste text or a link"
          className="w-full min-w-0 resize-y rounded-xl border border-line bg-surface px-3 py-2 text-ink placeholder:text-muted"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button kind="primary" onClick={send} disabled={!canSend || !draft.trim()}>Send text</Button>
          <span className="hidden text-xs text-muted sm:inline">Ctrl + Enter sends</span>
        </div>
        {problem && <Note tone="bad">{problem}</Note>}
      </div>
    </div>
  );
}

function Bubble({ m }: { m: ChatMsg }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(m.body);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // No clipboard on plain-http pages: select the text so the device's own Copy works.
      const el = document.getElementById("msg-" + m.id);
      if (el) window.getSelection()?.selectAllChildren(el);
    }
  };
  return (
    <li className={`flex max-w-[90%] flex-col gap-1 ${m.mine ? "self-end items-end" : "self-start items-start"}`}>
      <div
        id={"msg-" + m.id}
        className={`whitespace-pre-wrap break-words rounded-2xl px-3 py-2 [overflow-wrap:anywhere] ${m.mine ? "bg-accent-soft" : "border border-line bg-surface"}`}
      >
        <Linked text={m.body} />
      </div>
      <div className="flex items-center gap-2 text-xs text-muted">
        <span>{new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
        {m.mine && <span>{m.delivered ? "Delivered" : "Sending…"}</span>}
        <button type="button" onClick={copy} className="min-h-8 cursor-pointer rounded-md px-2 underline-offset-2 hover:underline">
          {copied ? "Copied ✓" : "Copy"}
        </button>
      </div>
    </li>
  );
}

// Only http and https addresses become links; everything else stays plain text.
const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/gi;

function Linked({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer" className="text-accent underline">{p}</a>
        ) : (
          p
        ),
      )}
    </>
  );
}
