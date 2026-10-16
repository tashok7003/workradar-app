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
  /** true: a reply to someone who asked the manager something; false: a nudge to move work forward. */
  reply: boolean;
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
  const task = f.reply
    ? `Draft ${f.manager}'s reply to ${f.recipient} (${f.channel === "email" ? "an email" : `a ${f.channel} message`}, 2-4 sentences, plain and direct, no emoji). Acknowledge the ask and commit to a concrete next step. Do not promise dates or facts that are not in the data; where a fact is unknown, say ${f.manager} will confirm it and when.`
    : `Draft a short ${f.channel === "GitHub" ? "GitHub comment" : "Slack message"} to ${f.recipient} (2-3 sentences, friendly and direct, no emoji) that an engineering manager named ${f.manager} could send to move this work forward.`;
  const { reply: _r, manager: _m, channel: _c, recipient: _p, ...facts } = f;
  void _r; void _m; void _c; void _p;
  return [task, "Use only the facts below. Name the specific ask and a time. Reply with the message text only.", "", JSON.stringify(facts)].join("\n");
}

/** Tolerant JSON extraction: whole reply, a fenced block, or the outermost object. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  return JSON.parse(body);
}
