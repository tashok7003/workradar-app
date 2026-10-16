export type Source = "jira" | "github" | "slack" | "email";
export type Kind = "ticket" | "pr" | "message" | "email" | "alert" | "deploy";
export type Status = "todo" | "in_progress" | "review" | "blocked" | "done";
export type Severity = "p0" | "p1" | "p2" | "p3";

export interface Person {
  id: string;
  name: string;
  role: string;
  initials: string;
  /** Hue used for the avatar chip, so people are recognisable at a glance. */
  hue: number;
}

export interface Activity {
  at: number; // epoch ms
  who: string; // person id, or a display name for people outside the team
  text: string;
}

export interface Blocker {
  reason: string;
  /** Who the work is waiting on. "me" means the manager using WorkRadar. */
  waitingOn: string;
  since: number;
}

export interface WorkItem {
  id: string;
  key: string; // what the source calls it: PAY-482, PR #1287, #payments-oncall
  source: Source;
  kind: Kind;
  title: string;
  body: string;
  author: string;
  assignee: string | null;
  status: Status;
  severity?: Severity;
  labels: string[];
  createdAt: number;
  updatedAt: number;
  dueAt?: number;
  blocker?: Blocker;
  /** The manager has been asked something and has not answered. */
  needsReplyFromMe?: boolean;
  /** Purely informational; never ranks above "Later". */
  fyi?: boolean;
  links: string[]; // related item ids
  url: string;
  activity: Activity[];
}

export interface Snooze {
  until: number;
  label: string;
}

export interface Override {
  assignee?: string | null;
  done?: boolean;
  doneAt?: number;
  snooze?: Snooze;
}

export type SourceHealth = Record<Source, "ok" | "error">;

export interface Reason {
  label: string;
  points: number;
  tone: "critical" | "warning" | "info";
}

export interface Ranked {
  item: WorkItem;
  score: number;
  tier: "now" | "today" | "later";
  reasons: Reason[];
}
