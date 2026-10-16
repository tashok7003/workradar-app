/**
 * Server configuration, read once from the environment.
 * Every key stays on the server; the browser only ever sees what /api/health reports.
 */

export interface TeamMember { login: string; name: string; role: string }

export interface Config {
  port: number;
  /** model: the daily briefing. draftModel: short drafts, where speed matters more. */
  gemini: { apiKey: string; model: string; draftModel: string } | null;
  github: {
    token: string | null;
    repos: string[]; // "owner/name"
    manager: string; // GitHub login of the person using WorkRadar
    team: TeamMember[]; // optional display names and roles
  } | null;
}

/** GITHUB_TEAM="octocat:Mona Lisa:Backend engineer,hubot:Hubot:SRE" */
export function parseTeam(raw: string | undefined): TeamMember[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean).map((entry) => {
    const [login, name, role] = entry.split(":").map((x) => x?.trim());
    return { login, name: name || login, role: role || "GitHub contributor" };
  });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const repos = (env.GITHUB_REPOS ?? "").split(",").map((r) => r.trim()).filter((r) => /^[\w.-]+\/[\w.-]+$/.test(r));
  return {
    port: Number(env.PORT) || 8787,
    gemini: env.GEMINI_API_KEY
      ? {
          apiKey: env.GEMINI_API_KEY,
          model: env.GEMINI_MODEL || "gemini-3.8-flash",
          draftModel: env.GEMINI_DRAFT_MODEL || "gemini-3.5-flash-lite",
        }
      : null,
    github: repos.length
      ? {
          token: env.GITHUB_TOKEN || null,
          repos,
          manager: env.GITHUB_MANAGER || repos[0].split("/")[0],
          team: parseTeam(env.GITHUB_TEAM),
        }
      : null,
  };
}
