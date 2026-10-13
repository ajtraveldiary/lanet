import type { ButtonHTMLAttributes, ReactNode } from "react";
import { Icon, deviceIcon, type IconName } from "./icons";

export function Shell({ children }: { children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-6xl flex-col px-4 pb-28 lg:px-8 lg:pb-12">
      <header className="flex items-center py-5">
        <a href="/" className="flex items-center gap-2 rounded-lg text-ink no-underline">
          <img src="/icon.svg" alt="" className="size-8" />
          <span className="text-xl font-bold tracking-tight">lanet</span>
        </a>
      </header>
      <main className="flex flex-1 flex-col gap-4">{children}</main>
    </div>
  );
}

export function Card({ title, action, children, className = "" }: { title?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-3xl bg-surface p-4 shadow-[var(--shadow-card)] sm:p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

type Kind = "primary" | "teal" | "secondary";
const KINDS: Record<Kind, string> = {
  primary: "bg-accent text-on-accent hover:brightness-110 shadow-[0_6px_16px_rgb(91_61_245/0.25)]",
  teal: "bg-teal text-on-teal hover:brightness-105 shadow-[0_6px_16px_rgb(20_168_160/0.22)]",
  secondary: "bg-sunken text-ink hover:bg-accent-soft",
};

export function Button({ kind = "secondary", icon, className = "", children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { kind?: Kind; icon?: IconName }) {
  return (
    <button
      {...rest}
      className={`inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-2xl px-4 font-semibold transition disabled:cursor-default disabled:opacity-45 disabled:shadow-none ${KINDS[kind]} ${className}`}
    >
      {icon && <Icon name={icon} className="size-5 shrink-0" />}
      {children}
    </button>
  );
}

// A small rounded square with an icon: devices, files and directions.
export function IconTile({ name, tone = "bg-accent-soft text-accent", size = "size-10" }: { name: IconName; tone?: string; size?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center justify-center rounded-2xl ${size} ${tone}`}>
      <Icon name={name} className="size-[55%]" />
    </span>
  );
}

export function DeviceTile({ name, size }: { name: string; size?: string }) {
  return <IconTile name={deviceIcon(name)} size={size} />;
}

const LINK_TEXT = {
  connecting: "Connecting directly…",
  connected: "Connected directly",
  reconnecting: "Reconnecting…",
  blocked: "Can't connect directly",
  left: "Not connected",
} as const;

export function LinkPill({ link }: { link: keyof typeof LINK_TEXT }) {
  const look =
    link === "connected" ? "bg-teal-soft text-teal" :
    link === "blocked" ? "bg-bad-soft text-bad" :
    link === "left" ? "bg-sunken text-muted" : "bg-warn-soft text-on-warn";
  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${look}`}>
      <span className="size-1.5 rounded-full bg-current" aria-hidden />
      {LINK_TEXT[link]}
    </span>
  );
}

export const BLOCKED_HELP =
  "The devices found each other but couldn't connect directly. Check both are on the same Wi-Fi. " +
  "Some Wi-Fi networks (guest, office or hotel Wi-Fi) stop devices from reaching each other; a home Wi-Fi or a phone hotspot works.";

export function Note({ tone = "info", children }: { tone?: "info" | "bad" | "warn"; children: ReactNode }) {
  const look = tone === "bad" ? "bg-bad-soft text-bad" : tone === "warn" ? "bg-warn-soft text-on-warn" : "bg-accent-soft text-ink";
  return <p role={tone === "info" ? "status" : "alert"} className={`rounded-2xl px-3.5 py-2.5 text-sm ${look}`}>{children}</p>;
}

// A progress ring. `value` runs from 0 to 1.
export function Ring({ value, size = 28, stroke = 3, tone = "text-accent", children }: { value: number; size?: number; stroke?: number; tone?: string; children?: ReactNode }) {
  const r = (size - stroke) / 2, c = 2 * Math.PI * r;
  const v = Math.min(1, Math.max(0, value));
  return (
    <span className={`relative inline-flex shrink-0 items-center justify-center ${tone}`} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="absolute inset-0 -rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-line)" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - v)} className="transition-[stroke-dashoffset] duration-300"
        />
      </svg>
      {children && <span className="relative">{children}</span>}
    </span>
  );
}

export type Tab<T extends string> = { id: T; label: string; icon: IconName; badge?: number };

// The floating bar at the bottom of a phone screen. On a computer every part is on screen, so it hides.
export function TabBar<T extends string>({ tabs, current, onChange }: { tabs: Tab<T>[]; current: T; onChange: (t: T) => void }) {
  return (
    <nav aria-label="Sections" className="fixed inset-x-0 bottom-0 z-20 flex justify-center px-4 pb-[max(1rem,env(safe-area-inset-bottom))] lg:hidden">
      <div className="flex w-full max-w-sm gap-1 rounded-3xl bg-surface p-1.5 shadow-[var(--shadow-float)]">
        {tabs.map((t) => {
          const on = t.id === current;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onChange(t.id)}
              aria-current={on ? "page" : undefined}
              className={`relative flex min-h-12 flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-2xl px-2 text-sm font-semibold transition ${on ? "bg-accent text-on-accent" : "text-muted hover:text-ink"}`}
            >
              <Icon name={t.icon} className="size-5 shrink-0" />
              <span>{t.label}</span>
              {!!t.badge && (
                <span className={`min-w-5 rounded-full px-1.5 text-xs leading-5 ${on ? "bg-on-accent text-accent" : "bg-accent text-on-accent"}`} aria-label={`${t.badge} new`}>
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </nav>
  );
}

// On a phone only the chosen part shows; on a computer all of them do.
export const shownOn = (on: boolean) => (on ? "flex" : "hidden lg:flex");
