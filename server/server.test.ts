import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rank } from "../src/lib/priority";
import { createApp } from "./app";
import { loadConfig, parseTeam } from "./config";
import { extractText, generate } from "./gemini";
import { normalize, type GhIssue, type GhPull, type RepoSnapshot } from "./github";

const NOW = new Date("2026-10-16T09:30:00Z").getTime();
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const user = (login: string) => ({ login, type: "User" });

function pr(n: number, over: Partial<GhPull> = {}): GhPull {
  return {
    number: n, title: `PR ${n}`, body: null, html_url: `https://github.com/acme/api/pull/${n}`,
    user: user("arjun"), created_at: iso(30), updated_at: iso(2), head: { sha: `sha${n}` }, ...over,
  };
}
function issue(n: number, over: Partial<GhIssue> = {}): GhIssue {
  return {
    number: n, title: `Issue ${n}`, body: null, html_url: `https://github.com/acme/api/issues/${n}`,
    user: user("sara"), created_at: iso(48), updated_at: iso(5), ...over,
  };
}

const snapshot: RepoSnapshot = {
  repo: "acme/api",
  openPulls: [
    pr(10, { title: "Fix refund idempotency (fixes #3)", requested_reviewers: [user("tom")] }),
    pr(11, { title: "Bump jwt", user: { login: "dependabot[bot]", type: "Bot" }, requested_reviewers: [user("ashok")], created_at: iso(3) }),
    pr(12, { title: "Draft: ledger replica", draft: true }),
  ],
  openIssues: [
    issue(3, { title: "Refund webhooks failing", labels: [{ name: "P1" }, { name: "incident" }, { name: "customer" }], assignees: [user("diego")] }),
    issue(4, { title: "Card form copy", body: "Blocked on @ashok for sign-off on the copy.", labels: [{ name: "blocked" }], assignees: [user("sara")] }),
    issue(5, { title: "Upgrade Node", labels: [{ name: "low" }] }),
    issue(6, { title: "Question for the manager", body: "@ashok can you decide which region we launch in?" }),
    issue(99, { title: "A PR as seen by the issues API", pull_request: {} }),
  ],
  closedPulls: [pr(8, { title: "Retry jitter", merged_at: iso(4), closed_at: iso(4) }), pr(7, { merged_at: iso(60), closed_at: iso(60) })],
  closedIssues: [issue(2, { title: "Flaky test", closed_at: iso(3), state_reason: "completed" }), issue(1, { closed_at: iso(2), state_reason: "not_planned" })],
  ci: { 10: "success", 12: "failure" },
};

describe("GitHub normalizer", () => {
  const ws = normalize([snapshot], { manager: "ashok", team: [{ login: "tom", name: "Tom Becker", role: "Backend" }] }, NOW);
  const get = (n: number) => ws.items.find((i) => i.id === `gh-acme-api-${n}`)!;

  it("maps open work, recent merges and closes, and skips the rest", () => {
    expect(ws.items.map((i) => i.id).sort()).toEqual(
      ["gh-acme-api-10", "gh-acme-api-11", "gh-acme-api-12", "gh-acme-api-2", "gh-acme-api-3", "gh-acme-api-4", "gh-acme-api-5", "gh-acme-api-6", "gh-acme-api-8"].sort(),
    );
    expect(get(8).status).toBe("done");
    expect(get(2).status).toBe("done");
  });

  it("treats a review requested from the manager as blocked on you", () => {
    expect(get(11).blocker?.waitingOn).toBe("me");
    expect(get(11).author).toBe("Dependabot");
  });

  it("flags a stale review on someone else, using their team name", () => {
    expect(get(10).blocker?.waitingOn).toBe("tom");
    expect(get(10).blocker?.reason).toBe("a review from Tom Becker");
    expect(get(10).status).toBe("review");
  });

  it("reads severity and tags from labels", () => {
    expect(get(3).severity).toBe("p1");
    expect(get(3).labels).toEqual(expect.arrayContaining(["incident", "customer-facing"]));
    expect(get(5).severity).toBe("p3");
  });

  it("parses 'blocked on @manager' and plain mentions", () => {
    expect(get(4).status).toBe("blocked");
    expect(get(4).blocker).toMatchObject({ waitingOn: "me", reason: "your input" });
    expect(get(6).needsReplyFromMe).toBe(true);
  });

  it("links a PR to the issue it fixes, both ways", () => {
    expect(get(10).links).toContain("gh-acme-api-3");
    expect(get(3).links).toContain("gh-acme-api-10");
  });

  it("marks failing CI", () => {
    expect(get(12).labels).toEqual(expect.arrayContaining(["ci-failing", "draft"]));
  });

  it("produces data the ranking puts in a sensible order", () => {
    const order = rank(ws.items, NOW).map((r) => r.item.id);
    expect(order.indexOf("gh-acme-api-3")).toBeLessThan(order.indexOf("gh-acme-api-5"));
    expect(order.indexOf("gh-acme-api-11")).toBeLessThan(order.indexOf("gh-acme-api-12"));
  });
});

describe("config", () => {
  it("parses team and repos", () => {
    expect(parseTeam("tom:Tom Becker:Backend, sara")).toEqual([
      { login: "tom", name: "Tom Becker", role: "Backend" },
      { login: "sara", name: "sara", role: "GitHub contributor" },
    ]);
    const cfg = loadConfig({ GITHUB_REPOS: "acme/api, bad repo, acme/web", GEMINI_API_KEY: "k" });
    expect(cfg.github?.repos).toEqual(["acme/api", "acme/web"]);
    expect(cfg.github?.manager).toBe("acme");
    expect(cfg.gemini?.model).toBe("gemini-3.8-flash");
  });
});

describe("Gemini client", () => {
  it("reads text from both API shapes", () => {
    expect(extractText({ steps: [{ type: "thought" }, { type: "model_output", content: [{ type: "text", text: "hi" }] }] })).toBe("hi");
    expect(extractText({ candidates: [{ content: { parts: [{ text: "a" }, { text: "b" }] } }] })).toBe("ab");
  });

  it("falls back to generateContent when interactions isn't available", async () => {
    const calls: string[] = [];
    const fake = (async (url: string) => {
      calls.push(url);
      if (url.endsWith("/interactions")) return new Response("not found", { status: 404 });
      return Response.json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] });
    }) as unknown as typeof fetch;
    expect((await generate({ apiKey: "k", model: "m", prompt: "p" }, fake)).text).toBe("ok");
    expect(calls[1]).toContain("/models/m:generateContent");
  });
});

describe("Gemini speed settings", () => {
  it("asks for low thinking, and retries without it if the model refuses", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      if (body.generation_config) return new Response("unsupported", { status: 400 });
      return Response.json({ steps: [{ type: "model_output", content: [{ type: "text", text: "fast" }] }] });
    }) as unknown as typeof fetch;
    const r = await generate({ apiKey: "k", model: "m", prompt: "p", thinking: "minimal" }, fake);
    expect(r.text).toBe("fast");
    expect(bodies[0]).toMatchObject({ generation_config: { thinking_level: "minimal" } });
    expect(bodies[1].generation_config).toBeUndefined();
  });

  it("gives up after the timeout instead of hanging", async () => {
    const slow = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)))) as unknown as typeof fetch;
    await expect(generate({ apiKey: "k", model: "m", prompt: "p", timeoutMs: 50 }, slow)).rejects.toMatchObject({ status: 504 });
  });
});

describe("API server", () => {
  let base = "";
  let geminiCalls = 0;
  const fakeFetch = (async (input: string | URL) => {
    const url = String(input);
    if (url.includes("generativelanguage")) {
      geminiCalls++;
      return Response.json({ steps: [{ type: "model_output", content: [{ type: "text", text: '{"headline":"h","attention":[],"blocked":[],"happened":[],"suggestion":{"text":"s","ids":[]}}' }] }] });
    }
    if (url.includes("/check-runs")) return Response.json({ check_runs: [] });
    if (url.includes("/pulls?state=open")) return Response.json(snapshot.openPulls);
    if (url.includes("/issues?state=open")) return Response.json(snapshot.openIssues);
    return Response.json([]);
  }) as unknown as typeof fetch;

  const server = createApp(loadConfig({ GEMINI_API_KEY: "k", GITHUB_REPOS: "acme/api", GITHUB_MANAGER: "ashok" }), fakeFetch).listen(0);
  beforeAll(() => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
  afterAll(() => { server.close(); });

  it("reports what is configured without exposing keys", async () => {
    const h = await (await fetch(`${base}/api/health`)).json();
    expect(h).toEqual({ ok: true, ai: { provider: "gemini", model: "gemini-3.8-flash", draftModel: "gemini-3.5-flash-lite" }, github: { repos: ["acme/api"], manager: "ashok", authenticated: false } });
    expect(JSON.stringify(h)).not.toContain('"k"');
  });

  it("serves the GitHub workspace", async () => {
    const ws = await (await fetch(`${base}/api/github/workspace`)).json();
    expect(ws.items.length).toBeGreaterThan(3);
    expect(ws.me.id).toBe("me");
  });

  it("returns a briefing and caches identical requests", async () => {
    const body = JSON.stringify({ context: { manager: "Ashok", sources: ["GitHub"], openItems: [], finishedToday: [] } });
    const post = () => fetch(`${base}/api/ai/briefing`, { method: "POST", headers: { "content-type": "application/json" }, body });
    const a = await (await post()).json();
    const b = await (await post()).json();
    expect(a.briefing.headline).toBe("h");
    expect(b.cached).toBe(true);
    expect(geminiCalls).toBe(1);
  });

  it("rejects malformed AI requests", async () => {
    const res = await fetch(`${base}/api/ai/briefing`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(res.status).toBe(400);
  });
});
