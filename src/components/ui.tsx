import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { person, nameOf, teamList } from "../lib/people";
import { HOUR, nextMorning, nextWeek, clock } from "../lib/time";
import { useStore } from "../store";
import type { Reason, Snooze, Source, Status, WorkItem } from "../types";
import { Icon } from "./Icon";

export const SOURCE_LABEL: Record<Source, string> = { jira: "Jira", github: "GitHub", slack: "Slack", email: "Email" };

export function SourceBadge({ source }: { source: Source }) {
  return <span className={`src src-${source}`}>{SOURCE_LABEL[source]}</span>;
}

export function Avatar({ id, size = 24 }: { id: string | null | undefined; size?: number }) {
  const p = person(id);
  if (!p) {
    const label = id ? id.split(/\s|\(/)[0].slice(0, 2).toUpperCase() : "?";
    return <span className="avatar avatar-ext" style={{ width: size, height: size }} title={nameOf(id)}>{label}</span>;
  }
  return (
    <span className="avatar" style={{ width: size, height: size, ["--h" as string]: p.hue }} title={p.name}>
      {p.initials}
    </span>
  );
}

const STATUS_LABEL: Record<Status, string> = {
  todo: "To do", in_progress: "In progress", review: "In review", blocked: "Blocked", done: "Done",
};
export function StatusPill({ status }: { status: Status }) {
  return <span className={`pill pill-${status}`}>{STATUS_LABEL[status]}</span>;
}

export function ReasonChips({ reasons, max = 3 }: { reasons: Reason[]; max?: number }) {
  return (
    <span className="reasons">
      {reasons.slice(0, max).map((r) => (
        <span key={r.label} className={`reason reason-${r.tone}`}>{r.label}</span>
      ))}
    </span>
  );
}

// --------------------------------------------------------------- Popover

export function Popover({ trigger, children, align = "end" }: {
  trigger: (open: () => void, isOpen: boolean) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDoc); document.removeEventListener("keydown", onKey); };
  }, [open]);
  return (
    <span className="pop-anchor" ref={ref}>
      {trigger(() => setOpen((o) => !o), open)}
      {open && <div className={`pop pop-${align}`} role="menu">{children(() => setOpen(false))}</div>}
    </span>
  );
}

// --------------------------------------------------------------- Toasts

interface ToastMsg { id: number; text: string; undo?: () => void }
const ToastCtx = createContext<(t: Omit<ToastMsg, "id">) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const push = (t: Omit<ToastMsg, "id">) => {
    const id = Date.now() + Math.random();
    setToasts((ts) => [...ts.slice(-2), { ...t, id }]);
    setTimeout(() => setToasts((ts) => ts.filter((x) => x.id !== id)), 6000);
  };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div className="toast" key={t.id}>
            <span>{t.text}</span>
            {t.undo && (
              <button className="toast-undo" onClick={() => { t.undo!(); setToasts((ts) => ts.filter((x) => x.id !== t.id)); }}>
                <Icon name="undo" size={14} /> Undo
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// --------------------------------------------------------------- Actions

export function snoozeOptions(now = Date.now()): Snooze[] {
  const morning = nextMorning(now);
  const week = nextWeek(now);
  const dayName = (ts: number) => new Date(ts).toLocaleDateString([], { weekday: "short" });
  return [
    { until: now + HOUR, label: `1 hour (${clock(now + HOUR)})` },
    { until: now + 3 * HOUR, label: `3 hours (${clock(now + 3 * HOUR)})` },
    { until: morning, label: `${dayName(morning)} ${clock(morning)}` },
    { until: week, label: `Next week (${dayName(week)} ${clock(week)})` },
  ];
}

/** Assign / Snooze / Done for one item. Used in rows and on the detail page. */
export function ItemActions({ item, compact = false }: { item: WorkItem; compact?: boolean }) {
  const { assign, markDone, reopen, snooze, unsnooze, state } = useStore();
  const toast = useToast();
  const prevAssignee = item.assignee;
  const isSnoozed = (state.overrides[item.id]?.snooze?.until ?? 0) > state.now;

  if (item.status === "done") {
    return (
      <div className="actions">
        <button className="btn btn-quiet" onClick={() => { reopen(item.id); toast({ text: `Reopened ${item.key}` }); }}>
          <Icon name="undo" size={15} /> Reopen
        </button>
      </div>
    );
  }

  return (
    <div className={`actions${compact ? " actions-compact" : ""}`} onClick={(e) => e.stopPropagation()}>
      <Popover
        trigger={(toggle, open) => (
          <button className="btn btn-quiet btn-assign" onClick={toggle} aria-expanded={open} aria-haspopup="menu" title={item.assignee ? `Owner: ${nameOf(item.assignee)}` : "Assign"}>
            <Icon name="user" size={15} />
            {compact ? <span className="sr">Assign</span> : <span>{item.assignee ? "Reassign" : "Assign"}</span>}
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="pop-title">Assign {item.key} to</div>
            {teamList().map((p) => (
              <button
                key={p.id}
                role="menuitemradio"
                aria-checked={item.assignee === p.id}
                className={`pop-item${item.assignee === p.id ? " is-on" : ""}`}
                onClick={() => {
                  assign(item.id, p.id);
                  close();
                  toast({ text: `Assigned ${item.key} to ${p.name}`, undo: () => assign(item.id, prevAssignee) });
                }}
              >
                <Avatar id={p.id} size={22} />
                <span className="pop-item-main">{p.name}<small>{p.role}</small></span>
                {item.assignee === p.id && <Icon name="check" size={14} />}
              </button>
            ))}
            {item.assignee && (
              <button className="pop-item pop-item-muted" onClick={() => { assign(item.id, null); close(); toast({ text: `Unassigned ${item.key}`, undo: () => assign(item.id, prevAssignee) }); }}>
                Remove owner
              </button>
            )}
          </>
        )}
      </Popover>

      <Popover
        trigger={(toggle, open) => (
          <button className="btn btn-quiet btn-snooze" onClick={toggle} aria-expanded={open} aria-haspopup="menu" title="Snooze">
            <Icon name="snooze" size={15} />
            {compact ? <span className="sr">Snooze</span> : <span>{isSnoozed ? "Snoozed" : "Snooze"}</span>}
          </button>
        )}
      >
        {(close) => (
          <>
            <div className="pop-title">Hide {item.key} until</div>
            {snoozeOptions(state.now).map((o) => (
              <button
                key={o.label}
                className="pop-item"
                onClick={() => {
                  snooze(item.id, o);
                  close();
                  toast({ text: `Snoozed ${item.key} until ${o.label}`, undo: () => unsnooze(item.id) });
                }}
              >
                {o.label}
              </button>
            ))}
            {isSnoozed && (
              <button className="pop-item pop-item-muted" onClick={() => { unsnooze(item.id); close(); toast({ text: `${item.key} is back in your feed` }); }}>
                Unsnooze now
              </button>
            )}
          </>
        )}
      </Popover>

      <button
        className="btn btn-done"
        title="Mark done"
        onClick={() => { markDone(item.id); toast({ text: `Marked ${item.key} done`, undo: () => reopen(item.id) }); }}
      >
        <Icon name="check" size={15} />
        {compact ? <span className="sr">Mark done</span> : <span>Done</span>}
      </button>
    </div>
  );
}

// --------------------------------------------------------------- States

export function EmptyState({ title, body, action, art = "clear" }: {
  title: string; body: string; action?: ReactNode; art?: "clear" | "search" | "snooze";
}) {
  return (
    <div className="empty">
      <svg className="empty-art" viewBox="0 0 120 120" aria-hidden>
        <circle cx="60" cy="60" r="52" fill="var(--surface-2)" />
        <circle cx="60" cy="60" r="36" fill="none" stroke="var(--line-strong)" strokeDasharray="3 5" />
        <circle cx="60" cy="60" r="18" fill="none" stroke="var(--line-strong)" strokeDasharray="3 5" />
        {art === "clear" && <path d="M44 61l11 11 22-24" fill="none" stroke="var(--ok)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />}
        {art === "search" && <><circle cx="56" cy="56" r="13" fill="none" stroke="var(--ink-3)" strokeWidth="4" /><path d="M66 66l12 12" stroke="var(--ink-3)" strokeWidth="5" strokeLinecap="round" /></>}
        {art === "snooze" && <path d="M60 42v18l12 8" fill="none" stroke="var(--accent)" strokeWidth="5" strokeLinecap="round" />}
      </svg>
      <h3>{title}</h3>
      <p>{body}</p>
      {action}
    </div>
  );
}

export function Banner({ tone, title, children, action }: {
  tone: "error" | "warning" | "info"; title: string; children?: ReactNode; action?: ReactNode;
}) {
  return (
    <div className={`banner banner-${tone}`} role={tone === "error" ? "alert" : "status"}>
      <Icon name={tone === "info" ? "spark" : "alert"} size={18} />
      <div className="banner-body"><strong>{title}</strong>{children && <span>{children}</span>}</div>
      {action}
    </div>
  );
}
