import { useState } from "react";
import { Icon } from "../components/Icon";
import { ItemRow } from "../components/ItemRow";
import { Avatar, EmptyState, SourceBadge, SourceDot } from "../components/ui";
import { sourceLabel } from "../lib/sources";
import { teamList } from "../lib/people";
import { TIER_NOW, TIER_TODAY } from "../lib/priority";
import { ago } from "../lib/time";
import { useRouter, type FeedTab } from "../router";
import { useStore } from "../store";
import type { Source } from "../types";

const TABS: { id: FeedTab; label: string; hint: string }[] = [
  { id: "now", label: "Now", hint: `Score ${TIER_NOW}+` },
  { id: "today", label: "Today", hint: `Score ${TIER_TODAY}–${TIER_NOW - 1}` },
  { id: "later", label: "Later", hint: `Below ${TIER_TODAY}` },
  { id: "all", label: "All open", hint: "" },
  { id: "snoozed", label: "Snoozed", hint: "" },
];

export function Feed({ tab = "now" }: { tab?: FeedTab }) {
  const { ranked, snoozed, unsnooze, state, sourceIds } = useStore();
  const { go } = useRouter();
  const [sources, setSources] = useState<Source[]>([]);
  const [owner, setOwner] = useState<string>("");

  const filtered = ranked.filter((r) =>
    (tab === "all" || r.tier === tab) &&
    (!sources.length || sources.includes(r.item.source)) &&
    (!owner || (owner === "me" ? r.item.needsReplyFromMe || r.item.blocker?.waitingOn === "me" : owner === "none" ? !r.item.assignee && !r.item.needsReplyFromMe : r.item.assignee === owner)),
  );
  const count = (t: FeedTab) => (t === "snoozed" ? snoozed.length : t === "all" ? ranked.length : ranked.filter((r) => r.tier === t).length);
  const toggleSource = (s: Source) => setSources((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const filtersOn = sources.length > 0 || !!owner;

  return (
    <div className="page">
      <header className="page-head">
        <p className="eyebrow">Ranked across {sourceIds.length ? sourceIds.map(sourceLabel).join(", ") : "your sources"}</p>
        <h1>Priority feed</h1>
      </header>

      <div className="tabs" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={`tab${tab === t.id ? " is-on" : ""}`} onClick={() => go({ name: "feed", tab: t.id })} title={t.hint}>
            {t.label} <span className="tab-n">{count(t.id)}</span>
          </button>
        ))}
      </div>

      {tab !== "snoozed" && (
        <div className="filters">
          <div className="chips" role="group" aria-label="Filter by source">
            {sourceIds.length > 1 && sourceIds.map((s) => (
              <button key={s} className={`chip${sources.includes(s) ? " is-on" : ""}`} aria-pressed={sources.includes(s)} onClick={() => toggleSource(s)}>
                <SourceDot source={s} />{sourceLabel(s)}
              </button>
            ))}
          </div>
          <label className="select">
            <span className="sr">Filter by owner</span>
            <select id="feed-owner" value={owner} onChange={(e) => setOwner(e.target.value)}>
              <option value="">Anyone</option>
              <option value="me">Waiting on me</option>
              <option value="none">No owner</option>
              {teamList().map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          {filtersOn && <button className="link" onClick={() => { setSources([]); setOwner(""); }}>Clear filters</button>}
        </div>
      )}

      {tab === "snoozed" ? (
        snoozed.length ? (
          <div className="rows">
            {snoozed.map(({ item, snooze }) => (
              <article key={item.id} className="row row-later" onClick={() => go({ name: "item", id: item.id })} tabIndex={0}>
                <div className="row-main">
                  <div className="row-meta"><SourceBadge source={item.source} /><span className="key">{item.key}</span><span className="row-time">updated {ago(item.updatedAt, state.now)}</span></div>
                  <h4 className="row-title">{item.title}</h4>
                  <div className="row-foot"><span className="owner"><Avatar id={item.assignee} size={20} />Back {snooze.label}</span></div>
                </div>
                <div className="row-side">
                  <button className="btn btn-quiet" onClick={(e) => { e.stopPropagation(); unsnooze(item.id); }}>
                    <Icon name="undo" size={15} /> <span>Unsnooze</span>
                  </button>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <EmptyState art="snooze" title="Nothing snoozed" body="Snooze an item from the feed to hide it until a time you choose. It comes back on its own." />
        )
      ) : filtered.length ? (
        <div className="rows">{filtered.map((r) => <ItemRow key={r.item.id} r={r} showScore />)}</div>
      ) : filtersOn ? (
        <EmptyState
          art="search"
          title="No items match these filters"
          body="Try another source or owner, or clear the filters to see everything in this tab."
          action={<button className="btn btn-quiet" onClick={() => { setSources([]); setOwner(""); }}>Clear filters</button>}
        />
      ) : (
        <EmptyState
          art="clear"
          title={tab === "now" ? "Nothing needs you right now" : "This tab is clear"}
          body={tab === "now" ? "Every urgent item is handled, snoozed or done. Check Today for what's next." : "Items move here as their priority changes."}
          action={tab === "now" ? <button className="btn btn-quiet" onClick={() => go({ name: "feed", tab: "today" })}>Open Today</button> : undefined}
        />
      )}
    </div>
  );
}
