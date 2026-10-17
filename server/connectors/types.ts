import type { ConnectorType, Person, Status, WorkItem } from "../../src/types";

/**
 * A connector turns one outside tool into WorkRadar work items.
 *
 * Every connector is stored as a ConnectorConfig (type + settings) and
 * implemented by a ConnectorDef that knows how to fetch and translate. The
 * rest of WorkRadar (ranking, briefing, search, actions) only ever sees the
 * WorkItems a connector returns, so adding a tool never touches those parts.
 */

export interface ConnectorConfig {
  id: string; // short slug, unique; also used as each item's `source`
  type: ConnectorType;
  name: string; // what the sidebar shows, e.g. "Team calendar"
  enabled: boolean;
  settings: Record<string, unknown>;
  createdAt: number;
}

export interface ConnectorOutput {
  items: WorkItem[];
  people: Person[];
}

export interface ConnectorContext {
  fetch: typeof fetch;
  now: number;
  /** Google access token for the signed-in account (Google connectors only). */
  googleToken?: () => Promise<string>;
  /** Items pushed to a webhook connector. */
  pushed?: (connectorId: string) => Record<string, unknown>[];
}

export interface FieldSpec {
  key: string;
  label: string;
  help?: string;
  kind: "text" | "textarea" | "secret" | "select" | "number" | "boolean";
  options?: { value: string; label: string }[];
  placeholder?: string;
  required?: boolean;
  default?: string | number | boolean;
}

export interface ConnectorDef {
  type: ConnectorType;
  label: string;
  description: string;
  needsGoogle?: boolean;
  fields: FieldSpec[];
  /** Check settings before saving; return a message for the first problem. */
  validate?: (settings: Record<string, unknown>) => string | null;
  run: (cfg: ConnectorConfig, ctx: ConnectorContext) => Promise<ConnectorOutput>;
}

export class ConnectorError extends Error {
  constructor(message: string, public status = 502) { super(message); }
}

// ---- shared helpers ---------------------------------------------------------

export function hueOf(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export function initialsOf(name: string) {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}

export function personFor(id: string, name?: string, role = "Teammate"): Person {
  const display = name || id;
  return { id, name: display, role, initials: initialsOf(display), hue: hueOf(id) };
}

/** Map free-form status text from any tool onto WorkRadar's five statuses. */
export function mapStatus(raw: unknown): Status {
  const s = String(raw ?? "").toLowerCase();
  if (/(done|closed|complete|resolved|merged|shipped|finished)/.test(s)) return "done";
  if (/block|stuck|waiting|on hold/.test(s)) return "blocked";
  if (/review|qa|testing/.test(s)) return "review";
  if (/progress|doing|active|started|wip/.test(s)) return "in_progress";
  return "todo";
}

/** Read "a.b.0.c" out of a JSON value. */
export function getPath(obj: unknown, path: string | undefined): unknown {
  if (!path) return undefined;
  let cur: unknown = obj;
  for (const part of path.split(".").filter(Boolean)) {
    if (cur == null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function toTime(v: unknown): number | undefined {
  if (v == null || v === "") return undefined;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v; // seconds or ms
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : undefined;
}

export const str = (v: unknown, fallback = "") => (v == null ? fallback : String(v));
export const DAY = 86_400_000;
