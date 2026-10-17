import type { Activity, Person, WorkItem } from "../../src/types";
import { ConnectorError, DAY, personFor, str, toTime, type ConnectorConfig, type ConnectorContext, type ConnectorDef } from "./types";

// ---- Google Calendar ----------------------------------------------------------

export interface GEvent {
  id: string;
  status?: string;
  summary?: string;
  description?: string;
  htmlLink?: string;
  created?: string;
  updated?: string;
  eventType?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  organizer?: { email?: string; displayName?: string; self?: boolean };
  creator?: { email?: string; displayName?: string; self?: boolean };
  attendees?: { email?: string; displayName?: string; self?: boolean; responseStatus?: string }[];
}

const SKIP_EVENT_TYPES = new Set(["workingLocation", "outOfOffice", "focusTime", "birthday"]);

const stripHtml = (s: string) =>
  s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").trim();

export function mapCalendar(events: GEvent[], cfg: ConnectorConfig, now: number): { items: WorkItem[]; people: Person[] } {
  const s = cfg.settings;
  const include = str(s.include, "from");
  const fromList = str(s.from).split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const marker = str(s.marker, "[task]").toLowerCase();
  const people = new Map<string, Person>();
  const items: WorkItem[] = [];

  for (const ev of events) {
    if (ev.status === "cancelled" || SKIP_EVENT_TYPES.has(ev.eventType ?? "")) continue;
    const me = ev.attendees?.find((a) => a.self);
    if (me?.responseStatus === "declined") continue;

    const org = ev.organizer ?? ev.creator;
    const orgEmail = (org?.email ?? "").toLowerCase();
    const title = ev.summary?.trim() || "(No title)";
    const keep =
      include === "all" ||
      (include === "marker" && title.toLowerCase().includes(marker)) ||
      (include === "from" && !org?.self && (fromList.length === 0 || fromList.includes(orgEmail)));
    if (!keep) continue;

    const start = toTime(ev.start?.dateTime ?? ev.start?.date);
    const end = toTime(ev.end?.dateTime ?? ev.end?.date) ?? start;
    if (!start) continue;
    if (end! < now - DAY) continue; // older than a day: not today's work

    let author = "me";
    if (org && !org.self && orgEmail) {
      author = orgEmail;
      if (!people.has(orgEmail)) people.set(orgEmail, personFor(orgEmail, org.displayName || orgEmail.split("@")[0], "From Google Calendar"));
    }

    const status = end! <= now ? "done" : start <= now ? "in_progress" : "todo";
    const created = toTime(ev.created) ?? start;
    const activity: Activity[] = [{ at: created, who: author, text: author === "me" ? "Added to your calendar." : "Added this to your calendar." }];

    items.push({
      id: `${cfg.id}-${ev.id}`,
      key: "Calendar",
      source: cfg.id,
      kind: (ev.attendees?.length ?? 0) > 1 ? "event" : "task",
      title: include === "marker" ? title.replace(new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), "").trim() || title : title,
      body: ev.description ? stripHtml(ev.description).slice(0, 1200) : "No description in the calendar event.",
      author,
      assignee: "me",
      status,
      labels: ["calendar", ...(author !== "me" ? ["assigned-to-you"] : [])],
      createdAt: created,
      updatedAt: status === "done" ? end! : toTime(ev.updated) ?? created,
      dueAt: status === "done" ? undefined : start,
      needsReplyFromMe: me?.responseStatus === "needsAction" ? true : undefined,
      links: [],
      url: ev.htmlLink ?? "#",
      activity,
    });
  }
  return { items, people: [...people.values()] };
}

async function googleGet<T>(url: string, ctx: ConnectorContext): Promise<T> {
  if (!ctx.googleToken) throw new ConnectorError("Google isn't connected. Open Sources and choose Connect Google.", 401);
  const token = await ctx.googleToken();
  const res = await ctx.fetch(url, { headers: { authorization: `Bearer ${token}`, accept: "application/json" } });
  if (res.status === 401) throw new ConnectorError("Google rejected the sign-in. Reconnect Google from Sources.", 401);
  if (res.status === 403) {
    const body = await res.json().catch(() => ({}));
    const msg = body?.error?.message ?? "";
    throw new ConnectorError(/has not been used|disabled/i.test(msg)
      ? "This API isn't enabled in your Google Cloud project. Enable the Google Calendar API and Google Tasks API there, then retry."
      : `Google refused access (403). ${msg}`.trim(), 403);
  }
  if (res.status === 404) throw new ConnectorError("Google couldn't find that calendar or task list. Check the ID in this source's settings.", 404);
  if (!res.ok) throw new ConnectorError(`Google returned ${res.status}.`);
  return res.json() as Promise<T>;
}

export const googleCalendarConnector: ConnectorDef = {
  type: "google-calendar",
  label: "Google Calendar",
  description: "Events and tasks your manager or team put on your calendar, due at their start time.",
  needsGoogle: true,
  fields: [
    {
      key: "include", label: "Which events count as work", kind: "select", default: "from",
      options: [
        { value: "from", label: "Events other people added (optionally only from the emails below)" },
        { value: "marker", label: "Events whose title contains a marker" },
        { value: "all", label: "Every event" },
      ],
    },
    { key: "from", label: "Only from these people", kind: "text", placeholder: "manager@company.com", help: "Comma-separated emails. Leave empty to include anyone else's events." },
    { key: "marker", label: "Title marker", kind: "text", default: "[task]", help: "Used when you choose the marker option." },
    { key: "days", label: "Look ahead (days)", kind: "number", default: 14 },
    { key: "calendarId", label: "Calendar ID", kind: "text", default: "primary", help: "Leave as primary for your main calendar." },
  ],
  async run(cfg, ctx) {
    const days = Math.min(60, Math.max(1, Number(cfg.settings.days) || 14));
    const calendarId = encodeURIComponent(str(cfg.settings.calendarId, "primary") || "primary");
    const q = new URLSearchParams({
      timeMin: new Date(ctx.now - DAY).toISOString(),
      timeMax: new Date(ctx.now + days * DAY).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "250",
    });
    const data = await googleGet<{ items?: GEvent[] }>(`https://www.googleapis.com/calendar/v3/calendars/${calendarId}/events?${q}`, ctx);
    return mapCalendar(data.items ?? [], cfg, ctx.now);
  },
};

// ---- Google Tasks -------------------------------------------------------------

export interface GTask {
  id: string;
  title?: string;
  notes?: string;
  status?: "needsAction" | "completed";
  due?: string;
  completed?: string;
  updated?: string;
  deleted?: boolean;
  webViewLink?: string;
  assignmentInfo?: { linkToTask?: string; surfaceType?: string };
}

const SURFACE: Record<string, string> = { DOCUMENT: "Google Docs", SPACE: "Google Chat", GMAIL: "Gmail" };

export function mapTasks(lists: { title: string; tasks: GTask[] }[], cfg: ConnectorConfig, now: number): { items: WorkItem[]; people: Person[] } {
  const items: WorkItem[] = [];
  const people = new Map<string, Person>();
  for (const list of lists) {
    for (const t of list.tasks) {
      if (t.deleted || !t.title?.trim()) continue;
      const done = t.status === "completed";
      const completedAt = toTime(t.completed);
      if (done && (!completedAt || now - completedAt > DAY)) continue;

      const surface = t.assignmentInfo?.surfaceType ? SURFACE[t.assignmentInfo.surfaceType] ?? "Google Workspace" : null;
      const author = surface ?? "me";
      if (surface && !people.has(surface)) people.set(surface, personFor(surface, surface, "Assigned through Google"));

      // Google stores only the due date; treat it as due by the end of that day.
      const dueDay = toTime(t.due);
      const updated = toTime(t.updated) ?? now;
      items.push({
        id: `${cfg.id}-${t.id}`,
        key: list.title,
        source: cfg.id,
        kind: "task",
        title: t.title.trim(),
        body: t.notes?.trim() || (surface ? `Assigned to you in ${surface}.` : "No notes on this task."),
        author,
        assignee: "me",
        status: done ? "done" : "todo",
        labels: ["task", ...(surface ? ["assigned-to-you"] : [])],
        createdAt: updated,
        updatedAt: done ? completedAt! : updated,
        dueAt: !done && dueDay ? dueDay + DAY - 60_000 : undefined,
        links: [],
        url: t.assignmentInfo?.linkToTask ?? t.webViewLink ?? "#",
        activity: [{ at: done ? completedAt! : updated, who: done ? "me" : author, text: done ? "Completed in Google Tasks." : surface ? `Assigned to you in ${surface}.` : "Added to Google Tasks." }],
      });
    }
  }
  return { items, people: [...people.values()] };
}

export const googleTasksConnector: ConnectorDef = {
  type: "google-tasks",
  label: "Google Tasks",
  description: "Your to-dos from Google Tasks, including tasks people assign you in Google Docs and Chat.",
  needsGoogle: true,
  fields: [
    { key: "lists", label: "Task lists", kind: "text", placeholder: "My Tasks, Work", help: "Comma-separated list names. Leave empty for all lists." },
  ],
  async run(cfg, ctx) {
    const wanted = str(cfg.settings.lists).split(",").map((l) => l.trim().toLowerCase()).filter(Boolean);
    const all = await googleGet<{ items?: { id: string; title: string }[] }>("https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=100", ctx);
    const lists = (all.items ?? []).filter((l) => !wanted.length || wanted.includes(l.title.toLowerCase()));
    const withTasks = await Promise.all(lists.map(async (l) => {
      const q = new URLSearchParams({ showCompleted: "true", showHidden: "true", maxResults: "100" });
      const data = await googleGet<{ items?: GTask[] }>(`https://tasks.googleapis.com/tasks/v1/lists/${encodeURIComponent(l.id)}/tasks?${q}`, ctx);
      return { title: l.title, tasks: data.items ?? [] };
    }));
    return mapTasks(withTasks, cfg, ctx.now);
  },
};
