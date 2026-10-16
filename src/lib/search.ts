import type { WorkItem } from "../types";
import { nameOf } from "./people";

export interface Hit {
  item: WorkItem;
  score: number;
  /** Where the best match was found, for the result snippet. */
  field: "title" | "key" | "people" | "labels" | "body" | "activity";
  snippet: string;
}

function norm(s: string) {
  return s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "");
}

/**
 * Plain keyword search across every source. Each query word must match
 * somewhere in the item (AND semantics), and fields are weighted so a title
 * match outranks a match buried in a comment.
 */
export function search(items: WorkItem[], query: string): Hit[] {
  const words = norm(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const hits: Hit[] = [];
  for (const item of items) {
    const fields: [Hit["field"], string, number][] = [
      ["key", item.key, 6],
      ["title", item.title, 5],
      ["people", [item.author, item.assignee, item.blocker?.waitingOn].filter(Boolean).map((p) => nameOf(p)).join(" "), 3],
      ["labels", item.labels.join(" ") + " " + item.source + " " + item.status.replace("_", " "), 2],
      ["body", item.body, 1.5],
      ["activity", item.activity.map((a) => a.text).join(" "), 1],
    ];

    let total = 0;
    let best: { field: Hit["field"]; text: string; w: number } | null = null;
    let allMatched = true;

    for (const w of words) {
      let matchedThisWord = false;
      for (const [field, text, weight] of fields) {
        const t = norm(text);
        const idx = t.indexOf(w);
        if (idx === -1) continue;
        matchedThisWord = true;
        const wordStart = idx === 0 || /\W/.test(t[idx - 1]);
        total += weight * (wordStart ? 1.5 : 1);
        if (!best || weight > best.w) best = { field, text, w: weight };
      }
      if (!matchedThisWord) { allMatched = false; break; }
    }

    if (allMatched && best) {
      hits.push({ item, score: total, field: best.field, snippet: snippetAround(best.text, words) });
    }
  }
  return hits.sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt);
}

function snippetAround(text: string, words: string[]): string {
  if (text.length <= 140) return text;
  const t = norm(text);
  const first = Math.min(...words.map((w) => { const i = t.indexOf(w); return i === -1 ? Infinity : i; }));
  const idx = Number.isFinite(first) ? first : 0;
  const start = Math.max(0, idx - 50);
  return (start > 0 ? "…" : "") + text.slice(start, start + 140).trim() + (start + 140 < text.length ? "…" : "");
}

/** Split text into plain and highlighted runs for rendering. */
export function highlight(text: string, query: string): { text: string; hit: boolean }[] {
  // Lowercase only (no Unicode normalisation) so indices line up with `text`.
  const words = query.toLowerCase().split(/\s+/).filter((w) => w.length > 0);
  if (!words.length) return [{ text, hit: false }];
  const t = text.toLowerCase();
  const marks = new Array(text.length).fill(false);
  for (const w of words) {
    let i = t.indexOf(w);
    while (i !== -1) {
      for (let k = i; k < i + w.length && k < marks.length; k++) marks[k] = true;
      i = t.indexOf(w, i + w.length);
    }
  }
  const out: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const last = out[out.length - 1];
    if (last && last.hit === marks[i]) last.text += text[i];
    else out.push({ text: text[i], hit: marks[i] });
  }
  return out;
}
