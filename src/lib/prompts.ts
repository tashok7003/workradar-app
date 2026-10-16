/**
 * Prompt builders shared by the browser and the server.
 *
 * Pure functions with no imports, so the server can build the prompt itself
 * from structured data. The server never forwards free-form prompts from the
 * browser, which keeps the AI key from becoming an open proxy.
 */

export interface BriefingContext {
  manager: string;
  sources: string[];
  openItems: {
    id: string;
    key: string;
    source: string;
    title: string;
    status: string;
    owner: string;
    priority: string;
    why: string[];
    blocker?: { reason: string; waitingOn: string; for: string };
    due?: string;
    detail: string;
  }[];
  finishedToday: { id: string; key: string; title: string; by: string; when: string }[];
}

export interface NudgeFacts {
  /**
   * reply:   someone asked the manager something; draft the answer.
   * unblock: the work is waiting on the manager; draft the decision that clears it.
   * nudge:   the work is waiting on someone else; draft a message that moves it.
   */
  mode: "reply" | "unblock" | "nudge";
  manager: string;
  channel: "email" | "Slack" | "GitHub";
  recipient: string;
  key: string;
  title: string;
  detail: string;
  owner: string;
  author: string;
  blocker: { reason: string; waitingOn: string; for: string } | null;
  due: string | null;
}

const sourceList = (s: string[]) =>
  s.length <= 1 ? (s[0] ?? "the team's tools") : `${s.slice(0, -1).join(", ")} and ${s[s.length - 1]}`;

export function briefingPrompt(ctx: BriefingContext): string {
  return [
    "You are WorkRadar, a chief-of-staff assistant for an engineering manager.",
    `Write today's briefing from the work items below. They come from ${sourceList(ctx.sources)} and are already ranked by urgency (priority: now > today > later).`,
    "",
    "Rules:",
    "- Use only facts in the data. Do not invent people, numbers, times or causes.",
    "- Address the manager as \"you\". Plain, specific sentences. No filler, no exclamation marks.",
    "- Each line is one sentence, at most 24 words, and names the concrete next step where there is one.",
    "- Cite the item ids each line is about in its \"ids\" array, using only ids from the data.",
    "- When several items are one situation (an incident, its PR, a customer email), cover them in one line.",
    "- \"blocked\": who is blocked, on what, for how long. Lead with anything blocked on the manager (waitingOn \"You\").",
    "- If a list would be empty, return an empty array for it.",
    "",
    "Reply with only this JSON, no code fence:",
    '{"headline": "one sentence on the state of the day",',
    ' "attention": [{"text": "...", "ids": ["..."]}],',
    ' "blocked": [{"text": "...", "ids": ["..."]}],',
    ' "happened": [{"text": "...", "ids": ["..."]}],',
    ' "suggestion": {"text": "the single best thing to do in the next 30 minutes", "ids": ["..."]}}',
    "attention: 2-3 lines, most urgent first. blocked: up to 4 lines. happened: up to 3 lines from finishedToday.",
    "",
    "DATA:",
    JSON.stringify(ctx),
  ].join("\n");
}

export function nudgePrompt(f: NudgeFacts): string {
  const medium = f.channel === "email" ? "email" : f.channel === "GitHub" ? "GitHub comment" : "Slack message";
  const task =
    f.mode === "reply"
      ? `Draft ${f.manager}'s reply to ${f.recipient} as a short ${medium} (2-4 sentences). Answer or acknowledge the ask and commit to a concrete next step. Do not promise dates or facts that are not in the data; where a fact is unknown, say ${f.manager} will confirm it and when.`
      : f.mode === "unblock"
        ? `${f.manager} is the person this work is waiting on. Draft the ${medium} ${f.manager} posts to clear it (2-3 sentences). Open with the decision or sign-off itself. If the data doesn't say what the decision is, write it as a placeholder in square brackets, like [your decision]. Then say what ${f.recipient} should do next.`
        : `Draft a short ${medium} from ${f.manager} to ${f.recipient} (2-3 sentences) that moves this work forward: name the specific ask and when it's needed.`;
  const { mode: _r, manager: _m, channel: _c, recipient: _p, ...facts } = f;
  void _r; void _m; void _c; void _p;
  return [
    task,
    "Write in first person as the manager. Plain and direct, no emoji, no greeting filler, no thanking anyone for their patience.",
    "Write durations in words, and leave out any wait shorter than a day.",
    "Use only the facts below. Reply with the message text only.",
    "",
    JSON.stringify(facts),
  ].join("\n");
}

/** Tolerant JSON extraction: whole reply, a fenced block, or the outermost object. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(body);
}
