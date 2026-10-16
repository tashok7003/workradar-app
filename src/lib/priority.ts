import type { Ranked, Reason, WorkItem } from "../types";
import { DAY, HOUR, dueLabel, span } from "./time";

/**
 * Deterministic priority scoring.
 *
 * Ranking is rules-based on purpose: a manager has to be able to see *why*
 * something is at the top, and the order must not change between page loads.
 * The AI layer explains and summarises this ranking; it never decides it.
 */

const SEVERITY: Record<string, number> = { p0: 50, p1: 40, p2: 22, p3: 8 };

export const TIER_NOW = 55;
export const TIER_TODAY = 32;

export function scoreItem(item: WorkItem, all: WorkItem[], now = Date.now()): Ranked {
  const reasons: Reason[] = [];
  const add = (label: string, points: number, tone: Reason["tone"]) => reasons.push({ label, points, tone });

  if (item.severity) {
    const pts = SEVERITY[item.severity];
    add(item.severity.toUpperCase(), pts, item.severity === "p0" || item.severity === "p1" ? "critical" : "info");
  }

  if (item.blocker) {
    const waited = now - item.blocker.since;
    // Work waiting on the manager is the strongest signal WorkRadar has:
    // only the person reading this screen can clear it.
    if (item.blocker.waitingOn === "me") add(`Blocked on you · ${span(item.blocker.since, now)}`, 45, "critical");
    else add(`Blocked ${span(item.blocker.since, now)}`, 18 + Math.min(12, Math.floor(waited / DAY) * 4), "warning");
    if (item.blocker.waitingOn === "unassigned") add("Nobody on it", 10, "warning");
  }

  if (item.needsReplyFromMe && item.blocker?.waitingOn !== "me") add("Waiting on your reply", 18, "warning");

  if (item.dueAt) {
    const left = item.dueAt - now;
    const label = dueLabel(item.dueAt, now);
    if (left < 0) add(label, 38, "critical");
    else if (left < 8 * HOUR) add(label, 26, "critical");
    else if (left < DAY + 6 * HOUR) add(label, 16, "warning");
    else if (left < 3 * DAY) add(label, 6, "info");
  }

  if (item.labels.includes("incident") && (item.severity === "p0" || item.severity === "p1"))
    add("Active incident", 20, "critical");
  if (item.labels.includes("customer-facing")) add("Customer-facing", 14, "warning");
  if (item.labels.includes("security")) add("Security", 16, "warning");
  if (item.labels.includes("ci-failing")) add("CI failing", 8, "info");

  if (item.kind === "pr" && item.status === "review" && now - item.createdAt > DAY && item.blocker)
    add("Review stale >24h", 8, "warning");

  if (!item.assignee && !item.needsReplyFromMe && !item.fyi && item.kind !== "message")
    add("No owner", 10, "warning");

  // Work linked from an open P0/P1 inherits some of its urgency, and anything
  // that would unblock work waiting on the manager moves up with it.
  const parents = all.filter((o) => o.id !== item.id && o.status !== "done" && o.links.includes(item.id));
  const urgent = parents.find((o) => o.severity === "p0" || o.severity === "p1");
  if (urgent) add(`Tied to ${urgent.key}`, 18, "critical");
  const unblocks = parents.find((o) => o.blocker?.waitingOn === "me");
  if (unblocks && item.needsReplyFromMe && !item.blocker) add(`Unblocks ${unblocks.key}`, 20, "warning");

  let score = reasons.reduce((s, r) => s + r.points, 0);
  if (item.fyi) score = Math.min(score, 12);

  const tier: Ranked["tier"] = score >= TIER_NOW ? "now" : score >= TIER_TODAY ? "today" : "later";
  reasons.sort((a, b) => b.points - a.points);
  return { item, score, tier, reasons };
}

export function rank(items: WorkItem[], now = Date.now()): Ranked[] {
  return items
    .filter((i) => i.status !== "done")
    .map((i) => scoreItem(i, items, now))
    .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt);
}
