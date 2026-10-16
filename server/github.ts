import type { Activity, Blocker, Person, Severity, Status, WorkItem } from "../src/types";
import type { Config } from "./config";

/**
 * Live GitHub connector.
 *
 * Reads open and recently closed pull requests and issues from the configured
 * repositories, plus CI results for open PRs, and maps them onto the same
 * WorkItem shape the mock data uses. The browser never talks to GitHub
 * directly, so the token stays on the server.
 */

// ---- Minimal GitHub REST shapes (only the fields we read) -----------------

interface GhUser { login: string; type?: string }
interface GhLabel { name: string }
export interface GhPull {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: GhUser;
  assignees?: GhUser[];
  requested_reviewers?: GhUser[];
  draft?: boolean;
  labels?: GhLabel[];
  created_at: string;
  updated_at: string;
  merged_at?: string | null;
  closed_at?: string | null;
  head?: { sha: string };
}
export interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  user: GhUser;
  assignees?: GhUser[];
  labels?: GhLabel[];
  milestone?: { title: string; due_on: string | null } | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  state_reason?: string | null;
  pull_request?: unknown;
}
export type CiState = "failure" | "success" | "pending" | null;

export interface RepoSnapshot {
  repo: string; // owner/name
  openPulls: GhPull[];
  openIssues: GhIssue[];
  closedPulls: GhPull[];
  closedIssues: GhIssue[];
  ci: Record<number, CiState>;
}

export interface GithubWorkspace {
  items: WorkItem[];
  people: Person[];
  me: Person;
  repos: string[];
  fetchedAt: number;
}

const DAY = 86_400_000;
const t = (s: string) => new Date(s).getTime();

const isBot = (u?: GhUser | null) => !!u && (u.type === "Bot" || /\[bot\]$/.test(u.login));
const botName = (login: string) => login.replace(/\[bot\]$/, "").replace(/^./, (c) => c.toUpperCase());

function hueOf(login: string) {
  let h = 0;
  for (const ch of login) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}
function initialsOf(name: string) {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}

function severityOf(labels: string[]): Severity | undefined {
  const l = labels.join(" | ");
  if (/\b(p0|sev ?0|critical)\b/.test(l)) return "p0";
  if (/\b(p1|sev ?1|urgent|high)\b/.test(l)) return "p1";
  if (/\b(p2|sev ?2|medium)\b|(^|\| )bug( \||$)/.test(l)) return "p2";
  if (/\b(p3|sev ?3|low)\b/.test(l)) return "p3";
  return undefined;
}

function tagsOf(labels: string[]): string[] {
  const tags = new Set(labels);
  if (labels.some((l) => /security|vulnerab|cve/.test(l))) tags.add("security");
  if (labels.some((l) => /customer/.test(l))) tags.add("customer-facing");
  if (labels.some((l) => /incident|outage/.test(l))) tags.add("incident");
  return [...tags];
}

/** "#12", "fixes #12", "closes #12" in a title or body. */
function refsOf(text: string): number[] {
  return [...text.matchAll(/(?:^|[\s(])#(\d{1,6})\b/g)].map((m) => Number(m[1]));
}

export function normalize(
  snapshots: RepoSnapshot[],
  opts: { manager: string; team: { login: string; name: string; role: string }[] },
  now = Date.now(),
): Omit<GithubWorkspace, "fetchedAt"> {
  const manager = opts.manager.toLowerCase();
  const multi = snapshots.length > 1;
  const seen = new Map<string, Person>();
  const teamInfo = new Map(opts.team.map((m) => [m.login.toLowerCase(), m]));

  const pid = (u?: GhUser | null): string | null => {
    if (!u) return null;
    if (isBot(u)) return botName(u.login);
    const login = u.login;
    if (login.toLowerCase() === manager) return "me";
    if (!seen.has(login)) {
      const info = teamInfo.get(login.toLowerCase());
      const name = info?.name ?? login;
      seen.set(login, { id: login, name, role: info?.role ?? "GitHub contributor", initials: initialsOf(name), hue: hueOf(login) });
    }
    return login;
  };
  const display = (id: string | null) => (id === "me" ? "you" : id ? seen.get(id)?.name ?? id : "nobody");

  const items: WorkItem[] = [];
  const byKey = new Map<string, WorkItem>();

  for (const snap of snapshots) {
    const short = snap.repo.split("/")[1];
    const idOf = (n: number) => `gh-${snap.repo.replace("/", "-")}-${n}`;
    const issueKey = (n: number) => (multi ? `${short}#${n}` : `#${n}`);
    const prKey = (n: number) => (multi ? `${short} PR #${n}` : `PR #${n}`);
    const mentionsMe = (body: string | null) => !!body && new RegExp(`@${manager}\\b`, "i").test(body);

    // ---------------- Open issues ----------------
    for (const is of snap.openIssues.filter((i) => !i.pull_request)) {
      const labels = (is.labels ?? []).map((l) => l.name.toLowerCase());
      const body = is.body ?? "";
      const assignee = pid(is.assignees?.[0]);
      const author = pid(is.user) ?? is.user.login;

      let blocker: Blocker | undefined;
      const m = body.match(/blocked (?:by|on)\s+(@[\w-]+|#\d+|[^\n.]{3,80})/i);
      if (m || labels.some((l) => /blocked/.test(l))) {
        const ref = m?.[1]?.trim();
        if (ref?.startsWith("@")) {
          const who = pid({ login: ref.slice(1) })!;
          blocker = { reason: who === "me" ? "your input" : `input from ${display(who)}`, waitingOn: who, since: t(is.updated_at) };
        } else if (ref?.startsWith("#")) {
          blocker = { reason: `${issueKey(Number(ref.slice(1)))} to be resolved first`, waitingOn: issueKey(Number(ref.slice(1))), since: t(is.updated_at) };
        } else {
          blocker = { reason: ref ? ref.charAt(0).toLowerCase() + ref.slice(1) : "the blocker flagged on this issue", waitingOn: "a dependency", since: t(is.updated_at) };
        }
      }

      const status: Status = blocker ? "blocked" : assignee ? "in_progress" : "todo";
      const activity: Activity[] = [{ at: t(is.created_at), who: author, text: `Opened ${issueKey(is.number)}.` }];
      if (t(is.updated_at) - t(is.created_at) > 60_000) activity.push({ at: t(is.updated_at), who: assignee ?? author, text: "Updated on GitHub." });

      const item: WorkItem = {
        id: idOf(is.number),
        key: issueKey(is.number),
        source: "github",
        kind: "ticket",
        title: is.title,
        body: body.trim().slice(0, 1200) || "No description on GitHub.",
        author,
        assignee,
        status,
        severity: severityOf(labels),
        labels: tagsOf(labels),
        createdAt: t(is.created_at),
        updatedAt: t(is.updated_at),
        dueAt: is.milestone?.due_on ? t(is.milestone.due_on) : undefined,
        blocker,
        needsReplyFromMe: assignee !== "me" && author !== "me" && mentionsMe(body) ? true : undefined,
        links: [],
        url: is.html_url,
        activity,
      };
      items.push(item);
      byKey.set(item.id, item);
    }

    // ---------------- Open pull requests ----------------
    for (const pr of snap.openPulls) {
      const labels = (pr.labels ?? []).map((l) => l.name.toLowerCase());
      const author = pid(pr.user) ?? pr.user.login;
      const assignee = pid(pr.assignees?.[0]) ?? author;
      const reviewers = (pr.requested_reviewers ?? []).map((u) => pid(u)).filter((x): x is string => !!x);
      const ci = snap.ci[pr.number] ?? null;
      const age = now - t(pr.created_at);

      let blocker: Blocker | undefined;
      if (reviewers.includes("me")) {
        blocker = { reason: "your review", waitingOn: "me", since: t(pr.created_at) };
      } else if (reviewers.length && age > DAY) {
        blocker = { reason: `a review from ${display(reviewers[0])}`, waitingOn: reviewers[0], since: t(pr.created_at) };
      }

      const tags = tagsOf(labels);
      if (ci === "failure") tags.push("ci-failing");
      if (pr.draft) tags.push("draft");

      const activity: Activity[] = [{ at: t(pr.created_at), who: author, text: `Opened ${prKey(pr.number)}${reviewers.length ? ` and requested review from ${reviewers.map(display).join(", ")}` : ""}.` }];
      if (ci === "failure") activity.push({ at: t(pr.updated_at), who: "CI", text: "Checks failed on the latest commit." });
      else if (ci === "success") activity.push({ at: t(pr.updated_at), who: "CI", text: "Checks passed on the latest commit." });

      const item: WorkItem = {
        id: idOf(pr.number),
        key: prKey(pr.number),
        source: "github",
        kind: "pr",
        title: pr.title,
        body: (pr.body ?? "").trim().slice(0, 1200) || "No description on GitHub.",
        author,
        assignee,
        status: pr.draft ? "in_progress" : reviewers.length ? "review" : "in_progress",
        severity: severityOf(labels),
        labels: tags,
        createdAt: t(pr.created_at),
        updatedAt: t(pr.updated_at),
        blocker,
        links: refsOf(`${pr.title}\n${pr.body ?? ""}`).map(idOf).filter((id) => id !== idOf(pr.number)),
        url: pr.html_url,
        activity,
      };
      items.push(item);
      byKey.set(item.id, item);
    }

    // ---------------- Finished in the last 24 hours ----------------
    for (const pr of snap.closedPulls) {
      if (!pr.merged_at || now - t(pr.merged_at) > DAY) continue;
      const who = pid(pr.user) ?? pr.user.login;
      items.push({
        id: idOf(pr.number), key: prKey(pr.number), source: "github", kind: "pr", title: pr.title,
        body: (pr.body ?? "").trim().slice(0, 600) || "Merged.", author: who, assignee: who, status: "done",
        labels: [], createdAt: t(pr.created_at), updatedAt: t(pr.merged_at),
        links: refsOf(`${pr.title}\n${pr.body ?? ""}`).map(idOf), url: pr.html_url,
        activity: [{ at: t(pr.merged_at), who, text: `Merged ${prKey(pr.number)}.` }],
      });
    }
    for (const is of snap.closedIssues) {
      if (is.pull_request || !is.closed_at || now - t(is.closed_at) > DAY || is.state_reason === "not_planned") continue;
      const who = pid(is.assignees?.[0]) ?? pid(is.user) ?? is.user.login;
      items.push({
        id: idOf(is.number), key: issueKey(is.number), source: "github", kind: "ticket", title: is.title,
        body: (is.body ?? "").trim().slice(0, 600) || "Closed.", author: pid(is.user) ?? is.user.login, assignee: who, status: "done",
        labels: [], createdAt: t(is.created_at), updatedAt: t(is.closed_at),
        links: [], url: is.html_url,
        activity: [{ at: t(is.closed_at), who, text: `Closed ${issueKey(is.number)}.` }],
      });
    }
  }

  // Link both ways: a PR that references an issue makes the issue point back.
  for (const it of items) {
    it.links = it.links.filter((id) => byKey.has(id) || items.some((x) => x.id === id));
    for (const target of it.links) {
      const other = items.find((x) => x.id === target);
      if (other && !other.links.includes(it.id)) other.links.push(it.id);
    }
  }

  const meInfo = teamInfo.get(manager);
  const me: Person = { id: "me", name: meInfo?.name ?? opts.manager, role: meInfo?.role ?? "Engineering manager", initials: initialsOf(meInfo?.name ?? opts.manager), hue: 222 };

  return { items, people: [...seen.values()], me, repos: snapshots.map((s) => s.repo) };
}

// ---- Fetching ---------------------------------------------------------------

export class GithubError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

type Fetch = typeof fetch;

export async function fetchSnapshot(
  repo: string, token: string | null, now = Date.now(), fetchImpl: Fetch = fetch,
): Promise<RepoSnapshot> {
  const headers: Record<string, string> = {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "workradar",
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const get = async <T>(path: string): Promise<T> => {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, { headers });
    if (res.status === 404) throw new GithubError(404, `GitHub repository ${repo} wasn't found, or the token can't read it.`);
    if (res.status === 401) throw new GithubError(401, "The GitHub token was rejected. Create a new one and update GITHUB_TOKEN.");
    if (res.status === 403 || res.status === 429) throw new GithubError(res.status, "GitHub rate limit reached. Add a GITHUB_TOKEN or wait a few minutes.");
    if (!res.ok) throw new GithubError(res.status, `GitHub returned ${res.status} for ${repo}.`);
    return res.json() as Promise<T>;
  };

  const since = new Date(now - DAY).toISOString();
  const [openPulls, openIssues, closedPulls, closedIssues] = await Promise.all([
    get<GhPull[]>("/pulls?state=open&per_page=50"),
    get<GhIssue[]>("/issues?state=open&per_page=50"),
    get<GhPull[]>("/pulls?state=closed&sort=updated&direction=desc&per_page=30"),
    get<GhIssue[]>(`/issues?state=closed&since=${encodeURIComponent(since)}&per_page=30`),
  ]);

  // CI for the most recently updated open PRs (one call each, so capped).
  const ci: Record<number, CiState> = {};
  await Promise.all(
    [...openPulls].sort((a, b) => t(b.updated_at) - t(a.updated_at)).slice(0, 10).map(async (pr) => {
      if (!pr.head?.sha) return;
      try {
        const runs = await get<{ check_runs: { status: string; conclusion: string | null }[] }>(`/commits/${pr.head.sha}/check-runs?per_page=50`);
        const list = runs.check_runs ?? [];
        ci[pr.number] = !list.length ? null
          : list.some((r) => ["failure", "timed_out", "cancelled", "action_required"].includes(r.conclusion ?? "")) ? "failure"
          : list.some((r) => r.status !== "completed") ? "pending" : "success";
      } catch {
        ci[pr.number] = null; // CI is a nice-to-have signal; never fail the sync over it.
      }
    }),
  );

  return { repo, openPulls, openIssues, closedPulls, closedIssues, ci };
}

export async function fetchWorkspace(cfg: NonNullable<Config["github"]>, fetchImpl: Fetch = fetch, now = Date.now()): Promise<GithubWorkspace> {
  const snapshots = await Promise.all(cfg.repos.map((r) => fetchSnapshot(r, cfg.token, now, fetchImpl)));
  return { ...normalize(snapshots, { manager: cfg.manager, team: cfg.team }, now), fetchedAt: now };
}
