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
  /** Where connectors, webhook data and the Google token are saved. */
  dataDir: string;
  /** The address people open WorkRadar at; Google sends sign-ins back here. */
  publicUrl: string;
  google: { clientId: string; clientSecret: string; redirectUri: string } | null;
  /** When set, managing sources needs this token (required on a public server). */
  adminToken: string | null;
  me: { name: string; role: string };
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
  const publicUrl = (env.PUBLIC_URL || "http://localhost:5173").replace(/\/$/, "");
  const managerLogin = env.GITHUB_MANAGER || "";
  const meFromTeam = parseTeam(env.GITHUB_TEAM).find((m) => m.login.toLowerCase() === managerLogin.toLowerCase());
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
    dataDir: env.DATA_DIR || "data",
    publicUrl,
    google: env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
      ? { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, redirectUri: `${publicUrl}/api/auth/google/callback` }
      : null,
    adminToken: env.ADMIN_TOKEN || null,
    me: {
      name: env.ME_NAME || meFromTeam?.name || managerLogin || "You",
      role: env.ME_ROLE || (meFromTeam && meFromTeam.role !== "GitHub contributor" ? meFromTeam.role : "Engineering manager"),
    },
  };
}
