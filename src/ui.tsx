import type { ButtonHTMLAttributes, ReactNode } from "react";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col px-4 pb-10">
      <header className="flex items-center gap-2 py-4">
        <a href="/" className="flex items-center gap-2 rounded-md font-semibold text-ink no-underline">
          <img src="/icon.svg" alt="" className="size-7" />
          <span className="text-lg">Lanet</span>
        </a>
      </header>
      <main className="flex flex-1 flex-col gap-4">{children}</main>
    </div>
  );
}

export function Card({ title, children, className = "" }: { title?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-2xl border border-line bg-surface p-4 sm:p-5 ${className}`}>
      {title && <h2 className="mb-3 text-base font-semibold">{title}</h2>}
      {children}
    </section>
  );
}

type Kind = "primary" | "secondary";
const KINDS: Record<Kind, string> = {
  primary: "bg-accent text-on-accent border-accent hover:brightness-110",
  secondary: "bg-transparent text-ink border-line hover:bg-accent-soft",
};

export function Button({ kind = "secondary", className = "", ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: Kind }) {
  return (
    <button
      {...rest}
      className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-xl border px-4 font-medium transition disabled:cursor-default disabled:opacity-50 ${KINDS[kind]} ${className}`}
    />
  );
}

const LINK_TEXT = {
  connecting: "Connecting directly…",
  connected: "Connected directly",
  reconnecting: "Reconnecting…",
  blocked: "Can't connect directly",
} as const;

export function LinkPill({ link }: { link: keyof typeof LINK_TEXT }) {
  const look = link === "connected" ? "bg-accent-soft text-ink" : link === "blocked" ? "bg-bad-soft text-bad" : "bg-warn-soft text-on-warn";
  return <span className={`shrink-0 rounded-full px-2.5 py-0.5 text-xs ${look}`}>{LINK_TEXT[link]}</span>;
}

export const BLOCKED_HELP =
  "The devices found each other but couldn't connect directly. Check both are on the same Wi-Fi. " +
  "Some Wi-Fi networks (guest, office or hotel Wi-Fi) stop devices from reaching each other; a home Wi-Fi or a phone hotspot works.";

export function Note({ tone = "info", children }: { tone?: "info" | "bad" | "warn"; children: ReactNode }) {
  const look = tone === "bad" ? "bg-bad-soft text-bad" : tone === "warn" ? "bg-warn-soft text-on-warn" : "bg-accent-soft text-ink";
  return <p role={tone === "info" ? "status" : "alert"} className={`rounded-xl px-3 py-2 text-sm ${look}`}>{children}</p>;
}
