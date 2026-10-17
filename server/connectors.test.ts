import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { customFeedConnector, isSafeFeedUrl } from "./connectors/custom";
import { mapCalendar, mapTasks, type GEvent } from "./connectors/google";
import type { ConnectorConfig } from "./connectors/types";
import { GoogleAuth } from "./google-auth";

const NOW = new Date("2026-10-16T09:00:00Z").getTime();
const H = 3_600_000;
const iso = (offsetH: number) => new Date(NOW + offsetH * H).toISOString();
const cfg = (type: ConnectorConfig["type"], settings: Record<string, unknown> = {}, id = "src"): ConnectorConfig =>
  ({ id, type, name: "Source", enabled: true, settings, createdAt: NOW });

describe("Google Calendar mapping", () => {
  const boss = { email: "boss@acme.com", displayName: "Riya Boss" };
  const events: GEvent[] = [
    { id: "a", summary: "Finish Q4 report", organizer: boss, start: { dateTime: iso(5) }, end: { dateTime: iso(6) }, htmlLink: "https://cal/a",
      attendees: [{ email: "me@acme.com", self: true, responseStatus: "needsAction" }] },
    { id: "b", summary: "My own focus block", organizer: { email: "me@acme.com", self: true }, start: { dateTime: iso(2) }, end: { dateTime: iso(3) } },
    { id: "c", summary: "[task] Send invoice", organizer: { email: "me@acme.com", self: true }, start: { date: "2026-10-17" }, end: { date: "2026-10-18" } },
    { id: "d", summary: "Cancelled sync", status: "cancelled", organizer: boss, start: { dateTime: iso(1) }, end: { dateTime: iso(2) } },
    { id: "e", summary: "Office", eventType: "workingLocation", organizer: boss, start: { dateTime: iso(1) }, end: { dateTime: iso(9) } },
    { id: "f", summary: "Declined meeting", organizer: boss, start: { dateTime: iso(1) }, end: { dateTime: iso(2) },
      attendees: [{ email: "me@acme.com", self: true, responseStatus: "declined" }] },
    { id: "g", summary: "Review from Riya, done this morning", organizer: boss, start: { dateTime: iso(-3) }, end: { dateTime: iso(-2) } },
    { id: "h", summary: "Team lunch", organizer: { email: "pal@acme.com" }, start: { dateTime: iso(4) }, end: { dateTime: iso(5) } },
  ];

  it("keeps events other people added, skipping cancelled, declined and status blocks", () => {
    const { items, people } = mapCalendar(events, cfg("google-calendar", { include: "from", from: "" }), NOW);
    expect(items.map((i) => i.title).sort()).toEqual(["Finish Q4 report", "Review from Riya, done this morning", "Team lunch"]);
    expect(people.find((p) => p.id === "boss@acme.com")?.name).toBe("Riya Boss");
  });

  it("can limit to specific people", () => {
    const { items } = mapCalendar(events, cfg("google-calendar", { include: "from", from: "Boss@acme.com" }), NOW);
    expect(items.map((i) => i.title)).not.toContain("Team lunch");
  });

  it("maps an event to a task due at its start, waiting on your reply", () => {
    const it0 = mapCalendar(events, cfg("google-calendar", { include: "from", from: "boss@acme.com" }), NOW).items.find((i) => i.title === "Finish Q4 report")!;
    expect(it0).toMatchObject({ author: "boss@acme.com", assignee: "me", status: "todo", dueAt: NOW + 5 * H, needsReplyFromMe: true, url: "https://cal/a" });
    const done = mapCalendar(events, cfg("google-calendar", { include: "from" }), NOW).items.find((i) => i.title.startsWith("Review"))!;
    expect(done.status).toBe("done");
  });

  it("supports a title marker and strips it", () => {
    const { items } = mapCalendar(events, cfg("google-calendar", { include: "marker", marker: "[task]" }), NOW);
    expect(items.map((i) => i.title)).toEqual(["Send invoice"]);
  });
});

describe("Google Tasks mapping", () => {
  it("includes open tasks and today's completions, with due at end of day", () => {
    const { items, people } = mapTasks([{
      title: "Work",
      tasks: [
        { id: "1", title: "Update the deck", status: "needsAction", due: "2026-10-17T00:00:00.000Z", webViewLink: "https://tasks/1" },
        { id: "2", title: "Old finished", status: "completed", completed: iso(-48) },
        { id: "3", title: "Finished today", status: "completed", completed: iso(-2) },
        { id: "4", title: "Review section 3", status: "needsAction", assignmentInfo: { surfaceType: "DOCUMENT", linkToTask: "https://docs/x" } },
        { id: "5", title: "Gone", deleted: true },
      ],
    }], cfg("google-tasks"), NOW);
    expect(items.map((i) => i.title)).toEqual(["Update the deck", "Finished today", "Review section 3"]);
    expect(items[0]).toMatchObject({ key: "Work", dueAt: Date.parse("2026-10-17T23:59:00.000Z"), status: "todo" });
    expect(items[2]).toMatchObject({ author: "Google Docs", url: "https://docs/x" });
    expect(people.map((p) => p.id)).toEqual(["Google Docs"]);
  });
});

describe("Custom JSON feed", () => {
  const body = { data: { issues: [
    { key: "OPS-1", fields: { summary: "Rotate keys", status: { name: "In Progress" }, assignee: { name: "Ashok" }, priority: { name: "High" }, duedate: "2026-10-17" } },
    { key: "OPS-2", fields: { summary: "Fix backups", status: { name: "Blocked" }, assignee: { name: "Kim" } }, waiting: "vendor fix" },
    { key: "OPS-3", fields: { summary: "" } },
  ] } };
  const fake = (async (_u: string, init: RequestInit) => {
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer t0k");
    return Response.json(body);
  }) as unknown as typeof fetch;
  const settings = {
    url: "https://jira.example.com/rest/search", auth: "Authorization: Bearer t0k", itemsPath: "data.issues",
    f_title: "fields.summary", f_id: "key", f_status: "fields.status.name", f_owner: "fields.assignee.name",
    f_severity: "fields.priority.name", f_due: "fields.duedate", f_blocked: "waiting", me: "ashok",
  };

  it("maps fields by path, recognises you, and reads status and priority", async () => {
    const out = await customFeedConnector.run(cfg("custom-feed", settings, "ops"), { fetch: fake, now: NOW });
    expect(out.items).toHaveLength(2);
    expect(out.items[0]).toMatchObject({ id: "ops-OPS-1", key: "OPS-1", assignee: "me", status: "in_progress", severity: "p1", dueAt: Date.parse("2026-10-17") });
    expect(out.items[1]).toMatchObject({ assignee: "Kim", status: "blocked", blocker: { reason: "vendor fix" } });
  });

  it("explains a wrong list path", async () => {
    await expect(customFeedConnector.run(cfg("custom-feed", { ...settings, itemsPath: "nope" }), { fetch: fake, now: NOW })).rejects.toThrow(/No list found/);
  });

  it("blocks private addresses on a public server", () => {
    expect(isSafeFeedUrl("https://api.example.com/x", false)).toBe(true);
    for (const u of ["http://localhost:8787", "http://127.0.0.1/x", "http://10.0.0.5", "http://192.168.1.2", "http://169.254.169.254/latest", "file:///etc/passwd"]) {
      expect(isSafeFeedUrl(u, false)).toBe(false);
    }
  });
});

describe("Google sign-in", () => {
  it("builds a read-only consent URL and refreshes expired tokens", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wr-g-"));
    const calls: string[] = [];
    const idToken = `x.${Buffer.from(JSON.stringify({ email: "me@acme.com" })).toString("base64url")}.y`;
    const fake = (async (_u: string, init: RequestInit) => {
      const body = new URLSearchParams(String(init.body));
      calls.push(body.get("grant_type")!);
      return body.get("grant_type") === "authorization_code"
        ? Response.json({ access_token: "a1", refresh_token: "r1", expires_in: 1, id_token: idToken })
        : Response.json({ access_token: "a2", expires_in: 3600 });
    }) as unknown as typeof fetch;
    const g = new GoogleAuth({ clientId: "cid", clientSecret: "sec", redirectUri: "http://localhost:5173/api/auth/google/callback" }, dir, fake);
    const url = new URL(g.authUrl());
    expect(url.searchParams.get("scope")).toContain("calendar.readonly");
    expect(url.searchParams.get("scope")).toContain("tasks.readonly");
    expect(url.searchParams.get("access_type")).toBe("offline");
    await expect(g.complete("code", "wrong-state")).rejects.toThrow(/expired/);
    await g.complete("code", url.searchParams.get("state")!);
    expect(g.status()).toEqual({ configured: true, connected: true, email: "me@acme.com" });
    expect(await g.accessToken()).toBe("a2"); // the first token expired immediately
    expect(calls).toEqual(["authorization_code", "refresh_token"]);
  });
});

describe("Sources API", () => {
  let base = "";
  const server = createApp(loadConfig({ DATA_DIR: mkdtempSync(path.join(tmpdir(), "wr-api-")) }), fetch).listen(0, "127.0.0.1");
  beforeAll(() => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`; });
  afterAll(() => { server.close(); });
  const json = (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${url}`, { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });

  let hookId = "";
  let secret = "";

  it("creates a webhook source with a generated secret, never shown again", async () => {
    const res = await json("POST", "/api/connectors", { type: "webhook", name: "Zapier tasks", settings: { me: "ashok" } });
    expect(res.status).toBe(201);
    const out = await res.json();
    hookId = out.connector.id;
    secret = out.webhookSecret;
    expect(hookId).toBe("zapier-tasks");
    expect(secret.length).toBeGreaterThan(16);
    const list = await (await json("GET", "/api/connectors")).json();
    expect(list.connectors[0].settings.secret).toBe("");
    expect(list.connectors[0].secretsSet.secret).toBe(true);
    expect(list.catalog.map((c: { type: string }) => c.type)).toEqual(["github", "google-calendar", "google-tasks", "custom-feed", "webhook"]);
  });

  it("accepts pushes only with the secret, and shows them in the workspace", async () => {
    expect((await json("POST", `/api/hooks/${hookId}`, { title: "x" }, { "x-workradar-secret": "wrong" })).status).toBe(401);
    const ok = await json("POST", `/api/hooks/${hookId}`, { items: [
      { id: "z1", title: "Call the bank", owner: "Ashok", due: iso(3), priority: "urgent" },
      { id: "z2", title: "Order laptops", status: "blocked", blocked: "budget approval" },
    ] }, { "x-workradar-secret": secret });
    expect(await ok.json()).toMatchObject({ ok: true, received: 2, stored: 2 });
    const ws = await (await json("GET", "/api/workspace")).json();
    expect(ws.items.map((i: { title: string }) => i.title).sort()).toEqual(["Call the bank", "Order laptops"]);
    expect(ws.items.find((i: { title: string }) => i.title === "Call the bank")).toMatchObject({ source: hookId, assignee: "me", severity: "p1" });
    expect(ws.sources).toEqual([expect.objectContaining({ id: hookId, type: "webhook", status: "ok", count: 2 })]);
  });

  it("updates by id and keeps a secret left blank", async () => {
    const res = await json("PATCH", `/api/connectors/${hookId}`, { name: "Zaps", settings: { secret: "" } });
    expect((await res.json()).connector.name).toBe("Zaps");
    expect((await json("POST", `/api/hooks/${hookId}`, { title: "still works" }, { "x-workradar-secret": secret })).status).toBe(200);
  });

  it("validates settings with a clear message", async () => {
    const res = await json("POST", "/api/connectors", { type: "github", settings: { repos: "not a repo", manager: "x" } });
    expect(res.status).toBe(400);
    expect((await res.json()).message).toMatch(/owner\/repo/);
  });

  it("reports a failing source without hiding the others", async () => {
    await json("POST", "/api/connectors", { type: "google-calendar", name: "Calendar" });
    const ws = await (await json("GET", "/api/workspace")).json();
    const cal = ws.sources.find((s: { type: string }) => s.type === "google-calendar");
    expect(cal).toMatchObject({ status: "error" });
    expect(cal.error).toMatch(/GOOGLE_CLIENT_ID/);
    expect(ws.items.length).toBeGreaterThan(0);
  });

  it("deletes a source and its pushed items", async () => {
    expect((await json("DELETE", `/api/connectors/${hookId}`)).status).toBe(204);
    expect((await json("POST", `/api/hooks/${hookId}`, { title: "x" }, { "x-workradar-secret": secret })).status).toBe(404);
  });

  it("requires the admin token when one is set", async () => {
    const app = createApp(loadConfig({ DATA_DIR: mkdtempSync(path.join(tmpdir(), "wr-l-")), ADMIN_TOKEN: "s3cret" }), fetch);
    const locked = await new Promise<ReturnType<typeof app.listen>>((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
    const url = `http://127.0.0.1:${(locked.address() as AddressInfo).port}/api/connectors`;
    expect((await fetch(url)).status).toBe(403);
    expect((await fetch(url, { headers: { "x-admin-token": "s3cret" } })).status).toBe(200);
    locked.close();
  });
});
