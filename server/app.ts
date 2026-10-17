import express, { type Request, type Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { briefingPrompt, extractJson, nudgePrompt, type BriefingContext, type NudgeFacts } from "../src/lib/prompts";
import type { Config } from "./config";
import { generate, GeminiError } from "./gemini";
import { buildWorkspace, catalog, clearCache, CONNECTOR_DEFS, ConnectorStore, redact, runConnector } from "./connectors";
import { PushStore } from "./connectors/custom";
import { ConnectorError, initialsOf as initials, type ConnectorConfig, type ConnectorContext } from "./connectors/types";
import { GoogleAuth } from "./google-auth";

type Fetch = typeof fetch;

/** Small per-IP limiter so a public deploy can't burn the free Gemini quota. */
function limiter(max: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  return (req: Request, res: Response, next: () => void) => {
    const key = req.ip ?? "unknown";
    const now = Date.now();
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      res.status(429).json({ error: "rate_limited", message: "Too many AI requests. Try again in a minute." });
      return;
    }
    recent.push(now);
    hits.set(key, recent);
    next();
  };
}

/** Tiny TTL cache: identical prompts within 10 minutes reuse the answer. */
function ttlCache<T>(ttlMs: number) {
  const store = new Map<string, { at: number; value: T }>();
  return {
    get(key: string) {
      const hit = store.get(key);
      return hit && Date.now() - hit.at < ttlMs ? hit.value : undefined;
    },
    set(key: string, value: T) {
      store.set(key, { at: Date.now(), value });
      if (store.size > 200) store.delete(store.keys().next().value!);
    },
  };
}

const hash = (s: string) => createHash("sha256").update(s).digest("hex");

function isLocal(req: Request) {
  const ip = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
  const forwarded = req.get("x-forwarded-for");
  // Behind the Vite dev proxy the socket is local and there is no outside forwarder.
  return (ip === "127.0.0.1" || ip === "::1") && (!forwarded || /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)(,|$)/.test(forwarded.trim()));
}

function safeEqual(a: string, b: string) {
  if (!a || !b || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function createApp(cfg: Config, fetchImpl: Fetch = fetch) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "200kb" }));

  const aiCache = ttlCache<unknown>(10 * 60_000);
  const aiLimit = limiter(20, 60_000);
  const hookLimit = limiter(60, 60_000);

  // ---- sources (connectors) ----------------------------------------------------
  const google = new GoogleAuth(cfg.google, cfg.dataDir, fetchImpl);
  const pushes = new PushStore(cfg.dataDir);
  const seed: ConnectorConfig[] = cfg.github
    ? [{
        id: "github", type: "github", name: "GitHub", enabled: true, createdAt: Date.now(),
        settings: {
          repos: cfg.github.repos.join(", "), manager: cfg.github.manager, token: "",
          team: (process.env.GITHUB_TEAM ?? ""),
        },
      }]
    : [];
  const store = new ConnectorStore(cfg.dataDir, seed);
  const ctx = (): ConnectorContext => ({
    fetch: fetchImpl,
    now: Date.now(),
    googleToken: () => google.accessToken(),
    pushed: (id) => pushes.read(id),
  });

  /**
   * Managing sources stores credentials and makes the server fetch URLs, so it
   * is limited to the person running WorkRadar: requests from this machine, or
   * ones carrying ADMIN_TOKEN (required when the server is public).
   */
  const adminOnly = (req: Request, res: Response, next: () => void) => {
    const token = req.get("x-admin-token") ?? (typeof req.query.token === "string" ? req.query.token : undefined);
    if (cfg.adminToken ? token === cfg.adminToken : isLocal(req)) return next();
    res.status(403).json({
      error: "forbidden",
      message: cfg.adminToken
        ? "Managing sources needs the admin token. Enter it on the Sources page."
        : "Sources can only be changed from the computer running WorkRadar. Set ADMIN_TOKEN to manage them remotely.",
    });
  };
  const fail = (res: Response, e: unknown) => {
    const status = e instanceof ConnectorError ? e.status : 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({ error: "source_error", message: (e as Error).message });
  };

  app.get("/api/health", (req, res) => {
    res.json({
      ok: true,
      ai: cfg.gemini ? { provider: "gemini", model: cfg.gemini.model, draftModel: cfg.gemini.draftModel } : null,
      sources: store.all().filter((c) => c.enabled).map((c) => ({ id: c.id, type: c.type, name: c.name })),
      google: google.status(),
      canManage: cfg.adminToken ? null : isLocal(req), // null: needs the admin token
    });
  });

  /** Everything from every enabled source, as WorkItems. */
  const workspace = async (req: Request, res: Response) => {
    try {
      const ws = await buildWorkspace(store, ctx(), req.query.fresh === "1");
      res.json({ ...ws, me: { id: "me", name: cfg.me.name, role: cfg.me.role, initials: initials(cfg.me.name), hue: 222 } });
    } catch (e) { fail(res, e); }
  };
  app.get("/api/workspace", workspace);
  app.get("/api/github/workspace", workspace); // older clients

  app.get("/api/connectors", adminOnly, (_req, res) => {
    res.json({ connectors: store.all().map(redact), catalog: catalog(), google: google.status(), publicUrl: cfg.publicUrl });
  });

  app.post("/api/connectors", adminOnly, (req, res) => {
    try {
      const created = store.create(req.body ?? {});
      res.status(201).json({ connector: redact(created), webhookSecret: created.type === "webhook" ? created.settings.secret : undefined });
    } catch (e) { fail(res, e); }
  });

  app.patch("/api/connectors/:id", adminOnly, (req, res) => {
    try {
      const updated = store.update(req.params.id, req.body ?? {});
      clearCache(updated.id);
      res.json({ connector: redact(updated) });
    } catch (e) { fail(res, e); }
  });

  app.delete("/api/connectors/:id", adminOnly, (req, res) => {
    try {
      const existing = store.get(req.params.id);
      store.remove(req.params.id);
      clearCache(req.params.id);
      if (existing?.type === "webhook") pushes.clear(existing.id);
      res.status(204).end();
    } catch (e) { fail(res, e); }
  });

  /** Try settings without saving: returns how many items they produce and a sample. */
  app.post("/api/connectors/test", adminOnly, async (req, res) => {
    const { type, settings, id } = req.body ?? {};
    const def = CONNECTOR_DEFS[type as keyof typeof CONNECTOR_DEFS];
    if (!def) { res.status(400).json({ error: "source_error", message: "Unknown connector type." }); return; }
    // Editing an existing source: keep its saved secrets when the form leaves them blank.
    const saved = id ? store.get(String(id)) : undefined;
    const merged: Record<string, unknown> = { ...(saved?.settings ?? {}) };
    for (const [k, v] of Object.entries(settings ?? {})) if (!(v === "" && def.fields.find((f) => f.key === k)?.kind === "secret")) merged[k] = v;
    for (const f of def.fields) if ((merged[f.key] === undefined || merged[f.key] === "") && f.default !== undefined) merged[f.key] = f.default;
    const problem = def.validate?.(merged);
    if (problem) { res.status(400).json({ error: "source_error", message: problem }); return; }
    try {
      const out = await runConnector({ id: saved?.id ?? "test", type: def.type, name: saved?.name ?? def.label, enabled: true, settings: merged, createdAt: Date.now() }, ctx());
      res.json({ count: out.items.length, sample: out.items.slice(0, 5).map((i) => ({ title: i.title, status: i.status, owner: i.assignee, due: i.dueAt ?? null, url: i.url })) });
    } catch (e) { fail(res, e); }
  });

  // ---- Google sign-in ----------------------------------------------------------
  app.get("/api/auth/google/start", adminOnly, (_req, res) => {
    try { res.redirect(google.authUrl()); } catch (e) { res.status(400).send(String((e as Error).message)); }
  });
  app.get("/api/auth/google/callback", async (req, res) => {
    const back = (q: string) => res.redirect(`${cfg.publicUrl}/?google=${q}`);
    if (req.query.error) return back(encodeURIComponent(String(req.query.error)));
    try {
      await google.complete(String(req.query.code ?? ""), String(req.query.state ?? ""));
      clearCache();
      back("connected");
    } catch (e) {
      back(encodeURIComponent((e as Error).message));
    }
  });
  app.post("/api/auth/google/disconnect", adminOnly, (_req, res) => {
    google.disconnect();
    clearCache();
    res.json({ google: google.status() });
  });

  // ---- Webhook intake --------------------------------------------------------------
  app.post("/api/hooks/:id", hookLimit, (req, res) => {
    const cfgHook = store.get(req.params.id);
    if (!cfgHook || cfgHook.type !== "webhook") { res.status(404).json({ error: "not_found", message: "No webhook source with that id." }); return; }
    const given = req.get("x-workradar-secret") ?? String(req.query.secret ?? "");
    if (!safeEqual(given, String(cfgHook.settings.secret ?? ""))) { res.status(401).json({ error: "unauthorized", message: "Missing or wrong X-WorkRadar-Secret header." }); return; }
    const body = req.body ?? {};
    const incoming: unknown[] = Array.isArray(body) ? body : Array.isArray(body.items) ? body.items : [body];
    const records = incoming.filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && typeof (r as Record<string, unknown>).title === "string");
    if (!records.length) { res.status(400).json({ error: "invalid_request", message: "Send an item with a title, or { items: [...] }." }); return; }
    const total = pushes.push(cfgHook.id, records.slice(0, 200), body.replace === true);
    res.json({ ok: true, received: records.length, stored: total });
  });

  app.post("/api/ai/briefing", aiLimit, async (req, res) => {
    if (!cfg.gemini) { res.status(503).json({ error: "not_configured", message: "No AI key on this server. Set GEMINI_API_KEY." }); return; }
    const ctx = req.body?.context as BriefingContext | undefined;
    if (!ctx || !Array.isArray(ctx.openItems) || !Array.isArray(ctx.finishedToday)) {
      res.status(400).json({ error: "invalid_request", message: "Expected { context } with openItems and finishedToday." });
      return;
    }
    const prompt = briefingPrompt({ ...ctx, openItems: ctx.openItems.slice(0, 25), finishedToday: ctx.finishedToday.slice(0, 15) });
    const key = hash(prompt);
    const hit = req.body?.fresh ? undefined : aiCache.get(key);
    if (hit) { res.json({ briefing: hit, cached: true, model: cfg.gemini.model }); return; }
    try {
      const { text, ms, endpoint } = await generate(
        { apiKey: cfg.gemini.apiKey, model: cfg.gemini.model, prompt, thinking: "low", timeoutMs: 45_000 }, fetchImpl);
      console.log(`[ai] briefing ${(ms / 1000).toFixed(1)}s · ${cfg.gemini.model} · ${endpoint}`);
      let briefing: unknown;
      try { briefing = extractJson(text); } catch {
        res.status(502).json({ error: "invalid_json", message: "Gemini's reply wasn't valid JSON." });
        return;
      }
      aiCache.set(key, briefing);
      res.json({ briefing, cached: false, model: cfg.gemini.model });
    } catch (e) {
      const status = e instanceof GeminiError ? e.status : 502;
      console.warn(`[ai] failed: ${(e as Error).message}`);
      res.status(status === 429 ? 429 : status === 504 ? 504 : 502).json({
        error: status === 429 ? "rate_limited" : status === 504 ? "timeout" : "upstream_error",
        message: (e as Error).message,
      });
    }
  });

  app.post("/api/ai/draft", aiLimit, async (req, res) => {
    if (!cfg.gemini) { res.status(503).json({ error: "not_configured", message: "No AI key on this server. Set GEMINI_API_KEY." }); return; }
    const facts = req.body?.facts as NudgeFacts | undefined;
    if (!facts || typeof facts.title !== "string" || typeof facts.recipient !== "string") {
      res.status(400).json({ error: "invalid_request", message: "Expected { facts } describing one work item." });
      return;
    }
    const clip = (s: unknown, n: number) => String(s ?? "").slice(0, n);
    const prompt = nudgePrompt({ ...facts, title: clip(facts.title, 300), detail: clip(facts.detail, 1500) });
    try {
      const { text, ms, endpoint } = await generate(
        { apiKey: cfg.gemini.apiKey, model: cfg.gemini.draftModel, prompt, thinking: "minimal", timeoutMs: 20_000 }, fetchImpl);
      console.log(`[ai] draft ${(ms / 1000).toFixed(1)}s · ${cfg.gemini.draftModel} · ${endpoint}`);
      res.json({ text: text.replace(/^["“]|["”]$/g, "").trim(), model: cfg.gemini.draftModel, ms });
    } catch (e) {
      const status = e instanceof GeminiError ? e.status : 502;
      console.warn(`[ai] failed: ${(e as Error).message}`);
      res.status(status === 429 ? 429 : status === 504 ? 504 : 502).json({
        error: status === 429 ? "rate_limited" : status === 504 ? "timeout" : "upstream_error",
        message: (e as Error).message,
      });
    }
  });

  // Serve the built frontend when it exists (production: one service for UI + API).
  const dist = path.resolve(process.cwd(), "dist");
  if (existsSync(dist)) {
    app.use(express.static(dist));
    app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
  }

  return app;
}
