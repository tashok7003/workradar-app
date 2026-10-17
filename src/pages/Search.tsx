import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../components/Icon";
import { Avatar, EmptyState, SourceBadge, SourceDot, StatusPill } from "../components/ui";
import { sourceLabel } from "../lib/sources";
import { nameOf } from "../lib/people";
import { highlight, search } from "../lib/search";
import { ago } from "../lib/time";
import { useRouter } from "../router";
import { useStore } from "../store";
import type { Source } from "../types";

const SUGGESTED = ["Acme", "blocked", "Tom", "security", "checkout", "ledger"];

function Mark({ text, q }: { text: string; q: string }) {
  return <>{highlight(text, q).map((p, i) => (p.hit ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>))}</>;
}

export function Search({ initial = "" }: { initial?: string }) {
  const { items, state, sources, sourceIds } = useStore();
  const { go } = useRouter();
  const [q, setQ] = useState(initial);
  const [source, setSource] = useState<Source | "">("");
  const [includeDone, setIncludeDone] = useState(true);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => { setQ(initial); }, [initial]);

  const hits = useMemo(
    () => search(items, q).filter((h) => (!source || h.item.source === source) && (includeDone || h.item.status !== "done")),
    [items, q, source, includeDone],
  );

  const offline = (Object.keys(sources) as Source[]).filter((s) => sources[s] === "error");

  return (
    <div className="page">
      <header className="page-head">
        <p className="eyebrow">Every source, one box</p>
        <h1>Search</h1>
      </header>

      <form className="search-box" role="search" onSubmit={(e) => e.preventDefault()}>
        <Icon name="search" size={20} />
        <label htmlFor="search-q" className="sr">Search work</label>
        <input
          id="search-q"
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tickets, PRs, messages, people…"
          autoComplete="off"
        />
        {q && <button type="button" className="icon-btn" onClick={() => { setQ(""); input.current?.focus(); }} aria-label="Clear search"><Icon name="x" size={16} /></button>}
      </form>

      <div className="filters">
        <div className="chips" role="group" aria-label="Source">
          <button className={`chip${!source ? " is-on" : ""}`} aria-pressed={!source} onClick={() => setSource("")}>All sources</button>
          {sourceIds.map((s) => (
            <button key={s} className={`chip${source === s ? " is-on" : ""}`} aria-pressed={source === s} onClick={() => setSource(source === s ? "" : s)}>
              <SourceDot source={s} />{sourceLabel(s)}
            </button>
          ))}
        </div>
        <label className="check">
          <input id="search-done" type="checkbox" checked={includeDone} onChange={(e) => setIncludeDone(e.target.checked)} />
          Include done
        </label>
      </div>

      {offline.length > 0 && q && (
        <p className="inline-error"><Icon name="alert" size={14} /> {offline.map(sourceLabel).join(", ")} didn't sync, so results from {offline.length > 1 ? "those sources" : "it"} are missing.</p>
      )}

      {!q.trim() ? (
        <div className="search-start">
          <p className="muted">Try a person, a customer, a ticket key, or a status.</p>
          <div className="chips">
            {SUGGESTED.map((s) => <button key={s} className="chip" onClick={() => setQ(s)}>{s}</button>)}
          </div>
        </div>
      ) : hits.length ? (
        <>
          <p className="result-count" aria-live="polite">{hits.length} result{hits.length === 1 ? "" : "s"} for “{q.trim()}”</p>
          <ul className="results">
            {hits.map((h) => (
              <li key={h.item.id}>
                <button className="result" onClick={() => go({ name: "item", id: h.item.id })}>
                  <div className="row-meta">
                    <SourceBadge source={h.item.source} />
                    <span className="key"><Mark text={h.item.key} q={q} /></span>
                    <StatusPill status={h.item.status} />
                    <span className="row-time">{ago(h.item.updatedAt, state.now)}</span>
                  </div>
                  <h4 className="row-title"><Mark text={h.item.title} q={q} /></h4>
                  {h.field !== "title" && h.field !== "key" && (
                    <p className="snippet"><span className="snippet-field">{h.field === "people" ? "Person" : h.field === "labels" ? "Label" : h.field === "activity" ? "Activity" : "Detail"}</span> <Mark text={h.field === "people" ? [h.item.author, h.item.assignee].filter(Boolean).map((p) => nameOf(p)).join(", ") : h.snippet} q={q} /></p>
                  )}
                  <span className="owner"><Avatar id={h.item.assignee ?? (h.item.needsReplyFromMe ? "me" : null)} size={18} /> {h.item.assignee ? nameOf(h.item.assignee) : h.item.needsReplyFromMe ? "You" : "Unassigned"}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <EmptyState
          art="search"
          title={`No results for “${q.trim()}”`}
          body={source ? `Nothing in ${sourceLabel(source)} matches. Try all sources, or a shorter word.` : "Check the spelling or try a shorter word. Search covers titles, people, labels, descriptions and activity."}
          action={source ? <button className="btn btn-quiet" onClick={() => setSource("")}>Search all sources</button> : undefined}
        />
      )}
    </div>
  );
}
