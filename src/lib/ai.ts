import type { Ranked, WorkItem } from "../types";
import { firstName, manager, nameOf } from "./people";
import { briefingPrompt, extractJson, nudgePrompt, type BriefingContext, type NudgeFacts } from "./prompts";
import { isToday, span, dueLabel } from "./time";

/**
 * AI layer.
 *
 * Three providers, tried in order:
 *  1. Claude through the claude.ai Artifact runtime (`sample`), when the app is
 *     opened as a published artifact inside Claude.
 *  2. Google Gemini through WorkRadar's own server (/api/ai/*), when the server
 *     runs with GEMINI_API_KEY. The key never reaches the browser, and the
 *     server builds the prompt itself from structured data.
 *  3. A local rules-based writer, so the app always shows a briefing even with
 *     no model available. The UI labels it as rules-based, never as AI.
 *
 * Whatever the model returns is validated: every item it cites must exist in
 * the data it was given, or the citation is dropped.
 */

export interface Line { text: string; ids: string[] }
export interface Briefing {
  headline: string;
  attention: Line[];
  blocked: Line[];
  happened: Line[];
  suggestion: Line;
}

export type ProviderId = "claude-artifact" | "gemini" | "offline";
export interface ProviderInfo { id: ProviderId; label: string }

type SampleFn = ((input: string, opts?: object) => Promise<{ text: string }>) & {
  json: <T>(input: string, opts?: object) => Promise<T>;
};

let samplePromise: Promise<SampleFn | null> | null = null;
function getSample(): Promise<SampleFn | null> {
  if (!samplePromise) {
    const c = (globalThis as { claude?: { use?: (n: string) => Promise<unknown> } }).claude;
    samplePromise = c?.use ? (c.use("sample") as Promise<SampleFn | null>).catch(() => null) : Promise.resolve(null);
  }
  return samplePromise;
}

export interface ServerHealth {
  ok: boolean;
  ai: { provider: "gemini"; model: string; draftModel?: string } | null;
  sources: { id: string; type: string; name: string }[];
  google: { configured: boolean; connected: boolean; email: string | null };
  /** true: this browser may manage sources; false: it may not; null: needs the admin token. */
  canManage: boolean | null;
}

let healthPromise: Promise<ServerHealth | null> | null = null;
/**
 * Is WorkRadar's own server running here? null on static hosting (GitHub Pages,
 * Claude) or while the API is still starting. A null answer is not cached, so
 * a server that comes up after the page loads is picked up on the next check.
 */
export function serverHealth(force = false): Promise<ServerHealth | null> {
  if (!healthPromise || force) {
    const p = fetch("api/health", { headers: { accept: "application/json" }, cache: "no-store" })
      .then((r) => (r.ok && (r.headers.get("content-type") ?? "").includes("json") ? (r.json() as Promise<ServerHealth>) : null))
      .catch(() => null);
    healthPromise = p;
    p.then((h) => { if (!h && healthPromise === p) healthPromise = null; });
  }
  return healthPromise;
}

export async function detectProvider(): Promise<ProviderInfo> {
  const health = await serverHealth();
  if (health?.ai) return { id: "gemini", label: `Gemini (${health.ai.model})` };
  if (await getSample()) return { id: "claude-artifact", label: "Claude" };
  return { id: "offline", label: "Rules-based summary" };
}

export class AiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { method: "POST", signal, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new AiError(data?.error ?? `http_${res.status}`, data?.message ?? `Server returned ${res.status}`);
  return data as T;
}

async function askBriefing(provider: ProviderId, ctx: BriefingContext, signal?: AbortSignal, fresh = false): Promise<unknown> {
  if (provider === "gemini") {
    return (await postJson<{ briefing: unknown }>("api/ai/briefing", { context: ctx, fresh }, signal)).briefing;
  }
  if (provider === "claude-artifact") {
    const sample = await getSample();
    if (!sample) throw new AiError("unavailable", "Claude isn't available in this view.");
    try {
      return await sample.json(briefingPrompt(ctx), { signal, cache: { gcTime: 10 * 60_000, refresh: fresh } });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      throw new AiError(err.code ?? "upstream_error", err.message ?? "Claude request failed");
    }
  }
  throw new AiError("offline", "No model configured");
}

export function parseJson<T>(text: string): T {
  try {
    return extractJson(text) as T;
  } catch {
    throw new AiError("invalid_json", "The model's reply was not valid JSON");
  }
}

// ---------------------------------------------------------------------------
// Context sent to the model: compact, factual, already ranked.
// ---------------------------------------------------------------------------

export function buildContext(ranked: Ranked[], items: WorkItem[], now = Date.now()): BriefingContext {
  const open = ranked.slice(0, 18).map((r) => ({
    id: r.item.id,
    key: r.item.key,
    source: r.item.source,
    title: r.item.title,
    status: r.item.status,
    owner: r.item.assignee ? nameOf(r.item.assignee) : "unassigned",
    priority: r.tier,
    why: r.reasons.map((x) => x.label),
    blocker: r.item.blocker
      ? { reason: r.item.blocker.reason, waitingOn: nameOf(r.item.blocker.waitingOn), for: span(r.item.blocker.since, now) }
      : undefined,
    due: r.item.dueAt ? dueLabel(r.item.dueAt, now) : undefined,
    detail: r.item.body.slice(0, 280),
  }));
  const doneToday = items
    .filter((i) => i.status === "done" && isToday(i.updatedAt, now))
    .map((i) => ({ id: i.id, key: i.key, title: i.title, by: nameOf(i.assignee), when: span(i.updatedAt, now) + " ago" }));
  const label: Record<string, string> = { jira: "Jira", github: "GitHub", slack: "Slack", email: "email" };
  const sources = [...new Set(items.map((i) => label[i.source]))];
  return { manager: `${manager().name} (${manager().role})`, sources, openItems: open, finishedToday: doneToday };
}

function cleanLine(l: unknown, known: Set<string>): Line | null {
  if (!l || typeof l !== "object") return null;
  const o = l as { text?: unknown; ids?: unknown };
  const text = typeof o.text === "string" ? o.text.trim() : "";
  if (!text) return null;
  const ids = Array.isArray(o.ids) ? o.ids.map(String).filter((id) => known.has(id)) : [];
  return { text, ids: [...new Set(ids)] };
}

/** Drop anything malformed and any citation to an item that isn't in the data. */
export function validateBriefing(raw: unknown, items: WorkItem[]): Briefing {
  const known = new Set(items.map((i) => i.id));
  const r = (raw ?? {}) as Record<string, unknown>;
  const lines = (v: unknown, max: number) =>
    (Array.isArray(v) ? v : []).map((l) => cleanLine(l, known)).filter((l): l is Line => !!l).slice(0, max);
  const headline = typeof r.headline === "string" ? r.headline.trim() : "";
  const suggestion = cleanLine(r.suggestion, known);
  if (!headline || !suggestion) throw new AiError("invalid_shape", "The model's reply was missing required fields");
  return {
    headline,
    attention: lines(r.attention, 3),
    blocked: lines(r.blocked, 4),
    happened: lines(r.happened, 3),
    suggestion,
  };
}

export async function generateBriefing(
  provider: ProviderId, ranked: Ranked[], items: WorkItem[], opts: { signal?: AbortSignal; forceFail?: boolean; fresh?: boolean } = {},
): Promise<Briefing> {
  if (opts.forceFail) {
    await new Promise((r) => setTimeout(r, 900));
    throw new AiError("upstream_error", "Simulated failure (demo setting)");
  }
  if (provider === "offline") return offlineBriefing(ranked, items);
  const ctx = buildContext(ranked, items);
  const raw = await askBriefing(provider, ctx, opts.signal, opts.fresh);
  return validateBriefing(raw, items);
}

// ---------------------------------------------------------------------------
// Rules-based fallback writer. Same shape, deterministic, clearly labelled.
// ---------------------------------------------------------------------------

export function offlineBriefing(ranked: Ranked[], items: WorkItem[], now = Date.now()): Briefing {
  const nowTier = ranked.filter((r) => r.tier === "now");
  const blockedItems = ranked.filter((r) => r.item.blocker);
  const onMe = blockedItems.filter((r) => r.item.blocker!.waitingOn === "me");
  const done = items.filter((i) => i.status === "done" && isToday(i.updatedAt, now));

  if (!ranked.length) {
    return {
      headline: "Nothing is open across your sources. Your team has no blocked or urgent work.",
      attention: [], blocked: [],
      happened: done.slice(0, 3).map((i) => ({ text: `${nameOf(i.assignee)} finished ${i.key}: ${i.title}.`, ids: [i.id] })),
      suggestion: { text: "Use the time for planning or 1:1s; WorkRadar will flag anything new.", ids: [] },
    };
  }

  const headline =
    `${nowTier.length} item${nowTier.length === 1 ? "" : "s"} need${nowTier.length === 1 ? "s" : ""} you now, ` +
    `${blockedItems.length} piece${blockedItems.length === 1 ? " of work is" : "s of work are"} blocked` +
    (onMe.length ? ` (${onMe.length} on you)` : "") +
    `, and ${done.length} thing${done.length === 1 ? "" : "s"} shipped or closed today.`;

  const why = (labels: string[]) => labels.map((l) => (/^P\d$/.test(l) ? l : l.charAt(0).toLowerCase() + l.slice(1))).join(", ");
  const attention = nowTier.slice(0, 3).map((r) => ({
    text: `${r.item.kind === "ticket" || r.item.kind === "pr" ? r.item.key + ": " : ""}${r.item.title} (${why(r.reasons.slice(0, 2).map((x) => x.label))}).`,
    ids: [r.item.id],
  }));

  const blocked = [...onMe, ...blockedItems.filter((r) => r.item.blocker!.waitingOn !== "me")].slice(0, 4).map((r) => {
    const b = r.item.blocker!;
    const who = r.item.assignee ?? r.item.author;
    const on = b.waitingOn === "me" ? "you" : b.waitingOn === "unassigned" ? "an owner" : nameOf(b.waitingOn);
    // The reason already names the other party, so "on whom" only leads when it's the manager.
    const lead = on === "you" ? `${nameOf(who)} has waited ${span(b.since, now)} on you for` : `${nameOf(who)} has waited ${span(b.since, now)} for`;
    return { text: `${lead} ${b.reason}.`, ids: [r.item.id] };
  });

  const happened = done
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 3)
    .map((i) => ({ text: `${firstName(i.assignee)} ${i.kind === "pr" ? "merged" : i.kind === "deploy" ? "shipped" : "closed"} ${i.key}: ${i.title}.`, ids: [i.id] }));

  const top = onMe[0] ?? nowTier[0] ?? ranked[0];
  const suggestion = {
    text: top.item.blocker?.waitingOn === "me"
      ? `Unblock ${firstName(top.item.assignee ?? top.item.author)} first. ${top.item.key} needs ${top.item.blocker.reason}.`
      : `Start with ${top.item.title}.`,
    ids: [top.item.id],
  };

  return { headline, attention, blocked, happened, suggestion };
}

// ---------------------------------------------------------------------------
// Per-item helper: draft a short nudge message.
// ---------------------------------------------------------------------------

export function wantsReply(item: WorkItem): boolean {
  return !!item.needsReplyFromMe && item.blocker?.waitingOn !== "unassigned";
}

/** Facts for one item, with names resolved, ready for the server-side prompt. */
export function nudgeFacts(item: WorkItem): NudgeFacts {
  const b = item.blocker;
  const mode: NudgeFacts["mode"] = wantsReply(item) ? "reply" : b?.waitingOn === "me" ? "unblock" : "nudge";
  const other = (id: string | null | undefined) => (id && id !== "me" ? nameOf(id) : null);
  const recipient =
    mode === "reply" ? nameOf(item.author)
    : mode === "unblock" ? other(item.assignee) ?? other(item.author) ?? "whoever picks this up"
    : b && b.waitingOn !== "unassigned" ? nameOf(b.waitingOn)
    : other(item.assignee) ?? "the team";
  return {
    mode,
    manager: manager().name,
    channel: item.source === "email" ? "email" : item.source === "github" ? "GitHub" : "Slack",
    recipient,
    key: item.key, title: item.title, detail: item.body,
    owner: nameOf(item.assignee), author: nameOf(item.author),
    blocker: b ? { reason: b.reason, waitingOn: nameOf(b.waitingOn), for: spanWords(b.since) } : null,
    due: item.dueAt ? dueLabel(item.dueAt) : null,
  };
}

/** "45 minutes", "26 hours", "3 days": readable in a message, unlike "26h". */
function spanWords(since: number, now = Date.now()): string {
  const m = Math.max(1, Math.round((now - since) / 60_000));
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"}`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"}`;
  const d = Math.round(h / 24);
  return `${d} days`;
}

export function offlineNudge(item: WorkItem): string {
  const b = item.blocker;
  if (wantsReply(item)) {
    const to = firstName(item.author);
    const when = item.dueAt ? (item.dueAt < Date.now() ? "today" : `within the next ${dueLabel(item.dueAt).replace("Due in ", "")}`) : "today";
    return `Hi ${to}, thanks for flagging this. I'm on it and will get back to you with a clear answer ${when}.`;
  }
  if (b?.waitingOn === "me") {
    const to = item.assignee && item.assignee !== "me" ? firstName(item.assignee) : item.author !== "me" ? firstName(item.author) : null;
    return `Decision on ${item.key}: [your decision]. ${to ? `${to}, you're clear to go ahead.` : "This needs an owner to take it from here."}`;
  }
  if (b && b.waitingOn !== "me" && b.waitingOn !== "unassigned") {
    return `Hi ${firstName(b.waitingOn)}, ${item.key} (${item.title}) has been waiting ${span(b.since)} for ${b.reason}. Could you take a look today, or tell me who else can?`;
  }
  if (b?.waitingOn === "unassigned") {
    return `Team, ${item.title.charAt(0).toLowerCase() + item.title.slice(1)}. We need ${b.reason}. Who can pick this up in the next hour?`;
  }
  const owner = item.assignee ? firstName(item.assignee) : "team";
  return `Hi ${owner}, checking on ${item.key} (${item.title}). What's left, and is anything in your way${item.dueAt ? ` before it's ${dueLabel(item.dueAt).toLowerCase()}` : ""}?`;
}

export async function draftNudge(provider: ProviderId, item: WorkItem, forceFail = false): Promise<string> {
  if (forceFail) throw new AiError("upstream_error", "Simulated failure (demo setting)");
  if (provider === "offline") return offlineNudge(item);
  if (provider === "gemini") return (await postJson<{ text: string }>("api/ai/draft", { facts: nudgeFacts(item) })).text;
  const sample = await getSample();
  if (!sample) throw new AiError("unavailable", "Claude isn't available in this view.");
  try {
    return (await sample(nudgePrompt(nudgeFacts(item)), { modelTier: "quick" })).text.trim();
  } catch (e) {
    const err = e as { code?: string; message?: string };
    throw new AiError(err.code ?? "upstream_error", err.message ?? "Claude request failed");
  }
}
