import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Person, Severity, WorkItem } from "../../src/types";
import { ConnectorError, getPath, mapStatus, personFor, str, toTime, type ConnectorConfig, type ConnectorDef } from "./types";

/**
 * Custom connectors: bring any tool into WorkRadar without writing code.
 *
 *  - JSON feed: WorkRadar reads a URL that returns JSON (most tools' REST APIs)
 *    and maps fields by path, e.g. "fields.summary" or "assignee.name".
 *  - Webhook: other tools (Zapier, Make, n8n, a script) push items to a URL.
 */

export interface FieldMap {
  id?: string; title: string; body?: string; status?: string; owner?: string;
  due?: string; url?: string; severity?: string; blocked?: string; created?: string; updated?: string;
}

function severityOf(v: unknown): Severity | undefined {
  const s = str(v).toLowerCase();
  if (/\b(p0|sev ?0|critical|blocker|highest)\b/.test(s)) return "p0";
  if (/\b(p1|sev ?1|urgent|high)\b/.test(s)) return "p1";
  if (/\b(p2|sev ?2|medium|normal)\b/.test(s)) return "p2";
  if (/\b(p3|sev ?3|low|lowest)\b/.test(s)) return "p3";
  return undefined;
}

/** Turn one record from any tool into a WorkItem using a field map. */
export function mapRecord(
  raw: unknown, map: FieldMap, cfg: ConnectorConfig, now: number, index: number,
  meValues: string[], people: Map<string, Person>,
): WorkItem | null {
  const title = str(getPath(raw, map.title)).trim();
  if (!title) return null;
  const rawId = str(getPath(raw, map.id)) || `${index}-${title.slice(0, 40)}`;
  const ownerRaw = str(getPath(raw, map.owner)).trim();
  const owner = !ownerRaw ? null : meValues.includes(ownerRaw.toLowerCase()) ? "me" : ownerRaw;
  if (owner && owner !== "me" && !people.has(owner)) people.set(owner, personFor(owner, owner, cfg.name));

  const blockedRaw = getPath(raw, map.blocked);
  const blockedText = blockedRaw === true ? "the blocker noted in " + cfg.name : typeof blockedRaw === "string" && blockedRaw.trim() ? blockedRaw.trim() : null;
  let status = map.status ? mapStatus(getPath(raw, map.status)) : "todo";
  if (blockedText && status !== "done") status = "blocked";

  const created = toTime(getPath(raw, map.created)) ?? now;
  const updated = toTime(getPath(raw, map.updated)) ?? created;
  const url = str(getPath(raw, map.url));

  return {
    id: `${cfg.id}-${rawId}`.slice(0, 200),
    key: rawId.length <= 16 ? rawId : cfg.name,
    source: cfg.id,
    kind: "task",
    title: title.slice(0, 300),
    body: str(getPath(raw, map.body)).trim().slice(0, 1500) || `From ${cfg.name}.`,
    author: owner ?? cfg.name,
    assignee: owner,
    status,
    severity: severityOf(getPath(raw, map.severity)),
    labels: [cfg.name.toLowerCase()],
    createdAt: created,
    updatedAt: updated,
    dueAt: toTime(getPath(raw, map.due)),
    blocker: blockedText ? { reason: blockedText.charAt(0).toLowerCase() + blockedText.slice(1), waitingOn: "a dependency", since: updated } : undefined,
    links: [],
    url: /^https?:\/\//.test(url) ? url : "#",
    activity: [{ at: updated, who: owner ?? cfg.name, text: `Synced from ${cfg.name}.` }],
  };
}

const meList = (cfg: ConnectorConfig) => str(cfg.settings.me).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

// ---- JSON feed -----------------------------------------------------------------

/** "Authorization: Bearer abc" → ["Authorization", "Bearer abc"] */
function parseHeader(line: string): [string, string] | null {
  const i = line.indexOf(":");
  if (i <= 0) return null;
  const name = line.slice(0, i).trim();
  return /^[\w-]+$/.test(name) ? [name, line.slice(i + 1).trim()] : null;
}

export function isSafeFeedUrl(u: string, allowPrivate: boolean): boolean {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (!/^https?:$/.test(url.protocol)) return false;
  if (allowPrivate) return true;
  // On a public deployment, don't let a feed URL reach the server's own network.
  const h = url.hostname.toLowerCase();
  return !(h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|0\.|\[?::1\]?$|\[?f[cd])/.test(h));
}

export const customFeedConnector: ConnectorDef = {
  type: "custom-feed",
  label: "Custom JSON feed",
  description: "Any tool with a JSON API: Jira, Linear, Notion, Trello, your own service. Map its fields once.",
  fields: [
    { key: "url", label: "Feed URL", kind: "text", required: true, placeholder: "https://api.example.com/tasks?assignee=me" },
    { key: "auth", label: "Auth header", kind: "secret", placeholder: "Authorization: Bearer …", help: "Optional. One header in Name: value form." },
    { key: "itemsPath", label: "Where the list is", kind: "text", placeholder: "issues", help: "Path to the array in the response, like issues or data.items. Leave empty if the response is the array." },
    { key: "f_title", label: "Title field", kind: "text", required: true, default: "title", placeholder: "fields.summary" },
    { key: "f_id", label: "ID field", kind: "text", default: "id", placeholder: "key" },
    { key: "f_status", label: "Status field", kind: "text", placeholder: "fields.status.name" },
    { key: "f_owner", label: "Owner field", kind: "text", placeholder: "fields.assignee.displayName" },
    { key: "f_due", label: "Due date field", kind: "text", placeholder: "fields.duedate" },
    { key: "f_severity", label: "Priority field", kind: "text", placeholder: "fields.priority.name" },
    { key: "f_body", label: "Description field", kind: "text", placeholder: "fields.description" },
    { key: "f_url", label: "Link field", kind: "text", placeholder: "url" },
    { key: "f_blocked", label: "Blocked field", kind: "text", placeholder: "blocked_reason", help: "Optional. True, or text describing what it waits on." },
    { key: "me", label: "Values that mean you", kind: "text", placeholder: "Ashok, ashok@company.com", help: "Owner values that should show as you." },
  ],
  validate: (s) => {
    if (!/^https?:\/\//i.test(str(s.url))) return "Enter the feed URL, starting with https://.";
    if (!str(s.f_title).trim()) return "Say which field holds the title.";
    if (s.auth && !parseHeader(str(s.auth))) return "Write the auth header as Name: value, like Authorization: Bearer abc.";
    return null;
  },
  async run(cfg, ctx) {
    const s = cfg.settings;
    const url = str(s.url);
    if (!isSafeFeedUrl(url, process.env.ALLOW_PRIVATE_FEEDS === "1" || process.env.NODE_ENV !== "production")) {
      throw new ConnectorError("That feed URL points to a private network address, which isn't allowed on a public server.", 400);
    }
    const headers: Record<string, string> = { accept: "application/json", "user-agent": "workradar" };
    const h = s.auth ? parseHeader(str(s.auth)) : null;
    if (h) headers[h[0]] = h[1];
    const res = await ctx.fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (res.status === 401 || res.status === 403) throw new ConnectorError(`The feed refused access (${res.status}). Check the auth header.`, res.status);
    if (!res.ok) throw new ConnectorError(`The feed returned ${res.status}.`);
    const json = await res.json().catch(() => { throw new ConnectorError("The feed didn't return JSON."); });
    const list = s.itemsPath ? getPath(json, str(s.itemsPath)) : json;
    if (!Array.isArray(list)) throw new ConnectorError(`No list found${s.itemsPath ? ` at “${s.itemsPath}”` : ""}. Set “Where the list is” to the path of the array.`, 400);

    const map: FieldMap = {
      title: str(s.f_title, "title"), id: str(s.f_id) || undefined, status: str(s.f_status) || undefined,
      owner: str(s.f_owner) || undefined, due: str(s.f_due) || undefined, severity: str(s.f_severity) || undefined,
      body: str(s.f_body) || undefined, url: str(s.f_url) || undefined, blocked: str(s.f_blocked) || undefined,
    };
    const people = new Map<string, Person>();
    const items = list.slice(0, 500).map((r, i) => mapRecord(r, map, cfg, ctx.now, i, meList(cfg), people)).filter((x): x is WorkItem => !!x);
    return { items, people: [...people.values()] };
  },
};

// ---- Webhook -------------------------------------------------------------------

/** Items pushed to webhook connectors, kept in data/webhooks/<id>.json. */
export class PushStore {
  constructor(private dir: string) {}
  private file(id: string) { return path.join(this.dir, "webhooks", `${id.replace(/[^\w-]/g, "")}.json`); }
  read(id: string): Record<string, unknown>[] {
    try { return existsSync(this.file(id)) ? JSON.parse(readFileSync(this.file(id), "utf8")) : []; } catch { return []; }
  }
  /** Upsert by `id`; `replace` swaps the whole list. Keeps the newest 500. */
  push(id: string, incoming: Record<string, unknown>[], replace = false): number {
    const byId = new Map<string, Record<string, unknown>>();
    if (!replace) for (const r of this.read(id)) byId.set(str(r.id), r);
    for (const r of incoming) {
      const key = str(r.id) || str(r.title);
      byId.set(key, { ...byId.get(key), ...r, id: key, _receivedAt: Date.now() });
    }
    const list = [...byId.values()].sort((a, b) => Number(b._receivedAt) - Number(a._receivedAt)).slice(0, 500);
    mkdirSync(path.dirname(this.file(id)), { recursive: true });
    writeFileSync(this.file(id), JSON.stringify(list));
    return list.length;
  }
  clear(id: string) {
    if (existsSync(this.file(id))) writeFileSync(this.file(id), "[]");
  }
}

export const WEBHOOK_FIELDS: FieldMap = {
  id: "id", title: "title", body: "description", status: "status", owner: "owner", due: "due",
  url: "url", severity: "priority", blocked: "blocked", created: "created", updated: "_receivedAt",
};

export const webhookConnector: ConnectorDef = {
  type: "webhook",
  label: "Custom webhook",
  description: "Let Zapier, Make, n8n or your own script push tasks into WorkRadar.",
  fields: [
    { key: "secret", label: "Secret", kind: "secret", help: "Senders must include it in the X-WorkRadar-Secret header. Leave empty to generate one." },
    { key: "me", label: "Values that mean you", kind: "text", placeholder: "Ashok, ashok@company.com", help: "Owner values that should show as you." },
  ],
  async run(cfg, ctx) {
    const records = ctx.pushed?.(cfg.id) ?? [];
    const people = new Map<string, Person>();
    const items = (records as unknown[]).map((r, i) => mapRecord(r, WEBHOOK_FIELDS, cfg, ctx.now, i, meList(cfg), people)).filter((x): x is WorkItem => !!x);
    // Done items only matter for "what happened today".
    return { items: items.filter((it) => it.status !== "done" || ctx.now - it.updatedAt < 86_400_000), people: [...people.values()] };
  },
};
