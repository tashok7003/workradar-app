import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ConnectorType, Person, SourceInfo, WorkItem } from "../../src/types";
import { customFeedConnector, webhookConnector } from "./custom";
import { githubConnector } from "./github";
import { googleCalendarConnector, googleTasksConnector } from "./google";
import { ConnectorError, type ConnectorConfig, type ConnectorContext, type ConnectorDef } from "./types";

export const CONNECTOR_DEFS: Record<ConnectorType, ConnectorDef> = {
  github: githubConnector,
  "google-calendar": googleCalendarConnector,
  "google-tasks": googleTasksConnector,
  "custom-feed": customFeedConnector,
  webhook: webhookConnector,
};

/** What the browser may see about a connector type (the form to show). */
export function catalog() {
  return Object.values(CONNECTOR_DEFS).map(({ type, label, description, needsGoogle, fields }) => ({ type, label, description, needsGoogle: !!needsGoogle, fields }));
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "source";

/**
 * Saved connectors, in data/connectors.json on the server.
 * Secrets live only here; the API never sends them back to the browser.
 */
export class ConnectorStore {
  private file: string;
  private list: ConnectorConfig[];

  constructor(dataDir: string, seed: ConnectorConfig[] = []) {
    this.file = path.join(dataDir, "connectors.json");
    let saved: ConnectorConfig[] | null = null;
    try { if (existsSync(this.file)) saved = JSON.parse(readFileSync(this.file, "utf8")); } catch { saved = null; }
    this.list = Array.isArray(saved) ? saved : seed;
    if (!saved && seed.length) this.save();
  }

  private save() {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.list, null, 2), { mode: 0o600 });
  }

  all() { return this.list; }
  get(id: string) { return this.list.find((c) => c.id === id); }

  create(input: { type: ConnectorType; name?: string; settings?: Record<string, unknown> }): ConnectorConfig {
    const def = CONNECTOR_DEFS[input.type];
    if (!def) throw new ConnectorError("Unknown connector type.", 400);
    const settings = withDefaults(def, input.settings ?? {});
    if (input.type === "webhook" && !settings.secret) settings.secret = randomBytes(18).toString("base64url");
    const problem = def.validate?.(settings);
    if (problem) throw new ConnectorError(problem, 400);
    const name = (input.name ?? "").trim() || def.label;
    let id = slug(name);
    for (let n = 2; this.get(id); n++) id = `${slug(name)}-${n}`;
    const cfg: ConnectorConfig = { id, type: input.type, name, enabled: true, settings, createdAt: Date.now() };
    this.list.push(cfg);
    this.save();
    return cfg;
  }

  update(id: string, patch: { name?: string; enabled?: boolean; settings?: Record<string, unknown> }): ConnectorConfig {
    const cfg = this.get(id);
    if (!cfg) throw new ConnectorError("That source no longer exists.", 404);
    const def = CONNECTOR_DEFS[cfg.type];
    if (patch.settings) {
      const next = { ...cfg.settings };
      for (const [k, v] of Object.entries(patch.settings)) {
        const field = def.fields.find((f) => f.key === k);
        if (!field) continue;
        // An empty secret in a form means "keep the saved one".
        if (field.kind === "secret" && (v === "" || v === undefined)) continue;
        next[k] = v;
      }
      const problem = def.validate?.(next);
      if (problem) throw new ConnectorError(problem, 400);
      cfg.settings = next;
    }
    if (typeof patch.name === "string" && patch.name.trim()) cfg.name = patch.name.trim();
    if (typeof patch.enabled === "boolean") cfg.enabled = patch.enabled;
    this.save();
    return cfg;
  }

  remove(id: string) {
    const before = this.list.length;
    this.list = this.list.filter((c) => c.id !== id);
    if (this.list.length === before) throw new ConnectorError("That source no longer exists.", 404);
    this.save();
  }
}

function withDefaults(def: ConnectorDef, settings: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const f of def.fields) {
    const v = settings[f.key];
    out[f.key] = v === undefined || v === "" ? (f.default ?? "") : v;
  }
  return out;
}

/** A connector as the browser sees it: secrets replaced by "is it set?". */
export function redact(cfg: ConnectorConfig) {
  const def = CONNECTOR_DEFS[cfg.type];
  const settings: Record<string, unknown> = {};
  const secretsSet: Record<string, boolean> = {};
  for (const f of def.fields) {
    if (f.kind === "secret") { secretsSet[f.key] = !!cfg.settings[f.key]; settings[f.key] = ""; }
    else settings[f.key] = cfg.settings[f.key] ?? "";
  }
  return { id: cfg.id, type: cfg.type, name: cfg.name, enabled: cfg.enabled, createdAt: cfg.createdAt, settings, secretsSet };
}

// ---- running connectors ---------------------------------------------------------

export interface Workspace { items: WorkItem[]; people: Person[]; sources: SourceInfo[]; fetchedAt: number }

const cache = new Map<string, { at: number; key: string; out: { items: WorkItem[]; people: Person[] } }>();

export async function runConnector(cfg: ConnectorConfig, ctx: ConnectorContext) {
  const out = await CONNECTOR_DEFS[cfg.type].run(cfg, ctx);
  // Each item carries its connector's id as its source, so labels and filters work per connector.
  for (const it of out.items) {
    it.source = cfg.id;
    if (!it.id.startsWith(`${cfg.id}-`)) it.id = `${cfg.id}-${it.id}`;
    it.links = it.links.map((l) => (l.startsWith(`${cfg.id}-`) ? l : `${cfg.id}-${l}`));
  }
  return out;
}

/** Run every enabled connector in parallel. One failing source never hides the others. */
export async function buildWorkspace(store: ConnectorStore, ctx: ConnectorContext, fresh = false, ttlMs = 60_000): Promise<Workspace> {
  const enabled = store.all().filter((c) => c.enabled);
  const results = await Promise.all(enabled.map(async (cfg): Promise<{ cfg: ConnectorConfig; out?: { items: WorkItem[]; people: Person[] }; error?: string; at: number }> => {
    const key = JSON.stringify(cfg.settings);
    const hit = cache.get(cfg.id);
    // Webhook data is local, so it is always read fresh.
    if (!fresh && cfg.type !== "webhook" && hit && hit.key === key && ctx.now - hit.at < ttlMs) return { cfg, out: hit.out, at: hit.at };
    try {
      const out = await runConnector(cfg, ctx);
      cache.set(cfg.id, { at: ctx.now, key, out });
      return { cfg, out, at: ctx.now };
    } catch (e) {
      return { cfg, error: (e as Error).message || "This source failed to sync.", at: ctx.now };
    }
  }));

  const people = new Map<string, Person>();
  const items: WorkItem[] = [];
  const sources: SourceInfo[] = [];
  for (const r of results) {
    if (r.out) {
      items.push(...r.out.items);
      for (const p of r.out.people) if (!people.has(p.id)) people.set(p.id, p);
    }
    sources.push({ id: r.cfg.id, type: r.cfg.type, name: r.cfg.name, status: r.error ? "error" : "ok", error: r.error, count: r.out?.items.length ?? 0, fetchedAt: r.at });
  }
  return { items, people: [...people.values()], sources, fetchedAt: ctx.now };
}

export function clearCache(id?: string) { if (id) cache.delete(id); else cache.clear(); }
