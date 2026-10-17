import type { ConnectorType, SourceInfo } from "../types";

/**
 * Display info for sources. The mock workspace has four fixed sources; in live
 * mode every connector the user adds is a source, named by the user.
 */

export const MOCK_SOURCES = ["jira", "github", "slack", "email"] as const;

const MOCK_META: Record<string, { label: string; color: string }> = {
  jira: { label: "Jira", color: "var(--jira)" },
  github: { label: "GitHub", color: "var(--github)" },
  slack: { label: "Slack", color: "var(--slack)" },
  email: { label: "Email", color: "var(--email)" },
};

export const TYPE_COLOR: Record<ConnectorType, string> = {
  github: "var(--github)",
  "google-calendar": "var(--gcal)",
  "google-tasks": "var(--gtasks)",
  "custom-feed": "var(--custom)",
  webhook: "var(--hook)",
};

export const TYPE_LABEL: Record<ConnectorType, string> = {
  github: "GitHub",
  "google-calendar": "Google Calendar",
  "google-tasks": "Google Tasks",
  "custom-feed": "JSON feed",
  webhook: "Webhook",
};

let live = new Map<string, SourceInfo>();

export function setLiveSources(list: SourceInfo[]) {
  live = new Map(list.map((s) => [s.id, s]));
}

export function sourceLabel(id: string): string {
  return live.get(id)?.name ?? MOCK_META[id]?.label ?? id;
}

export function sourceColor(id: string): string {
  const s = live.get(id);
  if (s) return TYPE_COLOR[s.type] ?? "var(--ink-3)";
  return MOCK_META[id]?.color ?? "var(--ink-3)";
}
