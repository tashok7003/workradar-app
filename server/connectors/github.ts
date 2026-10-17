import { fetchSnapshot, normalize } from "../github";
import { parseTeam } from "../config";
import { ConnectorError, type ConnectorDef } from "./types";

/** GitHub: pull requests, issues, reviews and CI from one or more repositories. */
export const githubConnector: ConnectorDef = {
  type: "github",
  label: "GitHub",
  description: "Open pull requests and issues, review requests, “blocked by” notes, @mentions and CI results.",
  fields: [
    { key: "repos", label: "Repositories", kind: "text", required: true, placeholder: "owner/repo, owner/other-repo", help: "Comma-separated." },
    { key: "manager", label: "Your GitHub login", kind: "text", required: true, placeholder: "tashok7003", help: "Review requests and @mentions for this login count as waiting on you." },
    { key: "token", label: "Access token", kind: "secret", placeholder: "github_pat_…", help: "Optional. Read-only fine-grained token: raises the limit from 60 to 5,000 requests an hour and allows private repos." },
    { key: "team", label: "Display names", kind: "text", placeholder: "octocat:Mona Lisa:Backend", help: "Optional. login:Name:Role, comma-separated." },
  ],
  validate: (s) => {
    const repos = String(s.repos ?? "").split(",").map((r) => r.trim()).filter(Boolean);
    if (!repos.length) return "Add at least one repository, like owner/repo.";
    const bad = repos.find((r) => !/^[\w.-]+\/[\w.-]+$/.test(r));
    if (bad) return `“${bad}” isn't a repository name. Use owner/repo.`;
    if (!String(s.manager ?? "").trim()) return "Add your GitHub login.";
    return null;
  },
  async run(cfg, ctx) {
    const s = cfg.settings;
    const repos = String(s.repos ?? "").split(",").map((r) => r.trim()).filter(Boolean);
    if (!repos.length) throw new ConnectorError("No repositories configured.", 400);
    const snapshots = await Promise.all(repos.map((r) => fetchSnapshot(r, (s.token as string) || process.env.GITHUB_TOKEN || null, ctx.now, ctx.fetch)));
    const ws = normalize(snapshots, { manager: String(s.manager ?? ""), team: parseTeam(String(s.team ?? "")) }, ctx.now);
    return { items: ws.items, people: ws.people };
  },
};
