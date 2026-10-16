const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export { MIN, HOUR, DAY };

/** "4m ago", "3h ago", "2d ago" */
export function ago(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  if (d < MIN) return "just now";
  if (d < HOUR) return `${Math.round(d / MIN)}m ago`;
  if (d < DAY) return `${Math.round(d / HOUR)}h ago`;
  return `${Math.round(d / DAY)}d ago`;
}

/** Length of a wait, without "ago": "42m", "26h", "3d" */
export function span(ts: number, now = Date.now()): string {
  const d = Math.max(0, now - ts);
  if (d < HOUR) return `${Math.max(1, Math.round(d / MIN))}m`;
  if (d < 2 * DAY) return `${Math.round(d / HOUR)}h`;
  return `${Math.round(d / DAY)}d`;
}

/** "Overdue 1h", "Due in 4h", "Due in 2d" */
export function dueLabel(due: number, now = Date.now()): string {
  const d = due - now;
  if (d < 0) return `Overdue ${span(due, now)}`;
  if (d < HOUR) return `Due in ${Math.max(1, Math.round(d / MIN))}m`;
  if (d < 36 * HOUR) return `Due in ${Math.round(d / HOUR)}h`;
  return `Due in ${Math.round(d / DAY)}d`;
}

export function clock(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export function isToday(ts: number, now = Date.now()): boolean {
  // "Today" in the working sense: the last 24 hours, so the demo reads the same at any hour.
  return now - ts < DAY;
}

/** Next 9:00 local time strictly after `now`. */
export function nextMorning(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(9, 0, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Monday 9:00 local of next week. */
export function nextWeek(now = Date.now()): number {
  const d = new Date(now);
  const add = ((8 - d.getDay()) % 7) || 7;
  d.setDate(d.getDate() + add);
  d.setHours(9, 0, 0, 0);
  return d.getTime();
}

export function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
