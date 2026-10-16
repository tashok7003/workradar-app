import express, { type Request, type Response } from "express";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { briefingPrompt, extractJson, nudgePrompt, type BriefingContext, type NudgeFacts } from "../src/lib/prompts";
import type { Config } from "./config";
import { generate, GeminiError } from "./gemini";
import { fetchWorkspace, GithubError, type GithubWorkspace } from "./github";

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

export function createApp(cfg: Config, fetchImpl: Fetch = fetch) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "200kb" }));

  const aiCache = ttlCache<unknown>(10 * 60_000);
  const ghCache = ttlCache<GithubWorkspace>(60_000);
  const aiLimit = limiter(20, 60_000);

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      ai: cfg.gemini ? { provider: "gemini", model: cfg.gemini.model, draftModel: cfg.gemini.draftModel } : null,
      github: cfg.github ? { repos: cfg.github.repos, manager: cfg.github.manager, authenticated: !!cfg.github.token } : null,
    });
  });

  app.get("/api/github/workspace", async (req, res) => {
    if (!cfg.github) {
      res.status(503).json({ error: "not_configured", message: "GitHub isn't connected on this server. Set GITHUB_REPOS." });
      return;
    }
    const fresh = req.query.fresh === "1";
    const cached = !fresh ? ghCache.get("ws") : undefined;
    if (cached) { res.json(cached); return; }
    try {
      const ws = await fetchWorkspace(cfg.github, fetchImpl);
      ghCache.set("ws", ws);
      res.json(ws);
    } catch (e) {
      const status = e instanceof GithubError ? e.status : 502;
      res.status(status === 404 || status === 401 ? status : 502).json({ error: "github_failed", message: (e as Error).message });
    }
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
