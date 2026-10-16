import { describe, expect, it } from "vitest";
import { buildItems } from "../data/mock";
import { offlineBriefing, parseJson, validateBriefing } from "./ai";
import { rank, scoreItem } from "./priority";
import { highlight, search } from "./search";

const NOW = new Date("2026-10-16T09:30:00").getTime();
const items = buildItems(NOW);

describe("priority ranking", () => {
  it("excludes done items and is deterministic", () => {
    const a = rank(items, NOW).map((r) => r.item.id);
    const b = rank(items, NOW).map((r) => r.item.id);
    expect(a).toEqual(b);
    expect(a.some((id) => items.find((i) => i.id === id)!.status === "done")).toBe(false);
  });

  it("puts work blocked on the manager in the Now tier", () => {
    const r = scoreItem(items.find((i) => i.id === "slack-oncall-replay")!, items, NOW);
    expect(r.tier).toBe("now");
    expect(r.reasons[0].label).toMatch(/Blocked on you/);
  });

  it("keeps FYI items out of the urgent tiers", () => {
    const r = scoreItem(items.find((i) => i.id === "slack-usability")!, items, NOW);
    expect(r.tier).toBe("later");
  });

  it("ranks the P1 incident above routine maintenance", () => {
    const order = rank(items, NOW).map((r) => r.item.id);
    expect(order.indexOf("jira-482")).toBeLessThan(order.indexOf("jira-485"));
  });
});

describe("search", () => {
  it("finds items across sources by customer name", () => {
    const hits = search(items, "acme").map((h) => h.item.source);
    expect(new Set(hits)).toEqual(new Set(["jira", "email", "slack"]));
  });
  it("requires every word to match", () => {
    expect(search(items, "acme ledger")).toHaveLength(0);
  });
  it("matches people by name", () => {
    expect(search(items, "kofi").length).toBeGreaterThan(0);
  });
  it("highlights matches without shifting text", () => {
    const parts = highlight("Refund webhooks", "web");
    expect(parts.map((p) => p.text).join("")).toBe("Refund webhooks");
    expect(parts.find((p) => p.hit)?.text).toBe("web");
  });
});

describe("AI output validation", () => {
  it("drops citations to items that do not exist", () => {
    const b = validateBriefing(
      { headline: "h", attention: [{ text: "t", ids: ["jira-482", "made-up-99"] }], blocked: [], happened: [], suggestion: { text: "s", ids: ["nope"] } },
      items,
    );
    expect(b.attention[0].ids).toEqual(["jira-482"]);
    expect(b.suggestion.ids).toEqual([]);
  });
  it("rejects a reply without a headline", () => {
    expect(() => validateBriefing({ attention: [] }, items)).toThrow();
  });
  it("parses JSON inside a code fence", () => {
    expect(parseJson<{ a: number }>("Here:\n```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
  });
  it("offline briefing cites only real items", () => {
    const b = offlineBriefing(rank(items, NOW), items, NOW);
    const known = new Set(items.map((i) => i.id));
    for (const l of [...b.attention, ...b.blocked, ...b.happened, b.suggestion]) for (const id of l.ids) expect(known.has(id)).toBe(true);
  });
});

describe("draft modes", () => {
  it("drafts the manager's decision when work is blocked on them", async () => {
    const { nudgeFacts } = await import("./ai");
    const { nudgePrompt } = await import("./prompts");
    const f = nudgeFacts(items.find((i) => i.id === "jira-490")!);
    expect(f.mode).toBe("unblock");
    expect(f.recipient).toBe("Sara Kim");
    expect(f.blocker?.for).toMatch(/days|hours|minutes/);
    expect(nudgePrompt(f)).toContain("[your decision]");
  });
  it("replies to whoever asked, and nudges whoever is blocking", async () => {
    const { nudgeFacts } = await import("./ai");
    expect(nudgeFacts(items.find((i) => i.id === "email-acme-eta")!).mode).toBe("reply");
    const pr = nudgeFacts(items.find((i) => i.id === "gh-1287")!);
    expect(pr).toMatchObject({ mode: "nudge", recipient: "Tom Becker" });
  });
});
