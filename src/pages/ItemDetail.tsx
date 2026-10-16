import { useEffect, useState } from "react";
import { Icon } from "../components/Icon";
import { Avatar, EmptyState, ItemActions, SourceBadge, StatusPill, SOURCE_LABEL } from "../components/ui";
import { detectProvider, draftNudge, offlineNudge, wantsReply, type ProviderInfo } from "../lib/ai";
import { nameOf } from "../lib/people";
import { scoreItem } from "../lib/priority";
import { ago, clock, dueLabel, span } from "../lib/time";
import { useRouter } from "../router";
import { useStore } from "../store";

export function ItemDetail({ id }: { id: string }) {
  const { byId, items, state } = useStore();
  const { back, go } = useRouter();
  const item = byId(id);
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [nudge, setNudge] = useState<{ text: string; by: "ai" | "rules"; secs?: number } | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [nudgeState, setNudgeState] = useState<"idle" | "loading" | "error">("idle");
  const [copied, setCopied] = useState(false);

  useEffect(() => { detectProvider().then(setProvider); }, []);
  useEffect(() => { setNudge(null); setNudgeState("idle"); setCopied(false); }, [id]);

  if (!item) {
    return (
      <div className="page">
        <button className="crumb" onClick={back}><Icon name="back" size={15} /> Back</button>
        <EmptyState
          art="search"
          title="This item isn't available"
          body="It may come from a source that didn't sync, or it was removed at the source. Check the source status in the sidebar, then try again."
          action={<button className="btn btn-quiet" onClick={() => go({ name: "dashboard" })}>Go to dashboard</button>}
        />
      </div>
    );
  }

  const ranked = scoreItem(item, items, state.now);
  const snooze = state.overrides[item.id]?.snooze;
  const isSnoozed = snooze && snooze.until > state.now;
  const related = item.links.map((l) => byId(l)).filter(Boolean);
  const maxPts = Math.max(...ranked.reasons.map((r) => r.points), 1);
  const reply = wantsReply(item);
  const unblock = !reply && item.blocker?.waitingOn === "me";

  const makeNudge = async () => {
    if (!provider) return;
    setNudgeState("loading");
    setCopied(false);
    const started = Date.now();
    setElapsed(0);
    const tick = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    try {
      const text = await draftNudge(provider.id, item, state.aiFails);
      setNudge({ text, by: provider.id === "offline" ? "rules" : "ai", secs: (Date.now() - started) / 1000 });
      setNudgeState("idle");
    } catch {
      setNudge({ text: offlineNudge(item), by: "rules" });
      setNudgeState("error");
    } finally {
      clearInterval(tick);
    }
  };

  const copy = async () => {
    if (!nudge) return;
    try { await navigator.clipboard.writeText(nudge.text); setCopied(true); }
    catch {
      const el = document.getElementById("nudge-text");
      if (el) { const r = document.createRange(); r.selectNodeContents(el); const sel = window.getSelection(); sel?.removeAllRanges(); sel?.addRange(r); }
    }
  };

  return (
    <div className="page detail">
      <button className="crumb" onClick={back}><Icon name="back" size={15} /> Back</button>

      <header className="detail-head">
        <div className="row-meta">
          <SourceBadge source={item.source} />
          <span className="key">{item.key}</span>
          <StatusPill status={item.status} />
          {item.severity && <span className={`sev sev-${item.severity}`}>{item.severity.toUpperCase()}</span>}
          {isSnoozed && <span className="pill pill-snoozed">Snoozed until {snooze!.label}</span>}
        </div>
        <h1>{item.title}</h1>
        <div className="detail-actions">
          <ItemActions item={item} />
          {item.url !== "#" && (
            <a className="btn btn-quiet" href={item.url} target="_blank" rel="noreferrer" title="Mock link: the demo has no live integrations">
              <Icon name="external" size={15} /> <span>Open in {SOURCE_LABEL[item.source]}</span>
            </a>
          )}
        </div>
      </header>

      <div className="detail-grid">
        <div className="detail-main">
          {item.blocker && (
            <section className={`blocker${item.blocker.waitingOn === "me" ? " on-me" : ""}`}>
              <Icon name="block" size={18} />
              <div>
                <strong>
                  {item.blocker.waitingOn === "me" ? "Blocked on you" : item.blocker.waitingOn === "unassigned" ? "Blocked: no owner" : `Blocked on ${nameOf(item.blocker.waitingOn)}`}
                  {" · "}{span(item.blocker.since, state.now)}
                </strong>
                <p>Needs {item.blocker.reason}.</p>
              </div>
            </section>
          )}

          <section className="panel">
            <header className="panel-head"><h2>Details</h2></header>
            <p className="detail-body">{item.body}</p>
          </section>

          {item.status !== "done" && (
            <section className="panel nudge">
              <header className="panel-head">
                <h2><Icon name="spark" size={16} /> Move it forward</h2>
                <button className="btn btn-primary btn-sm" onClick={makeNudge} disabled={nudgeState === "loading" || !provider}>
                  {nudgeState === "loading" ? `Drafting… ${elapsed}s` : nudge ? "Draft again" : reply ? "Draft a reply" : unblock ? "Draft my decision" : "Draft a nudge"}
                </button>
              </header>
              {!nudge && nudgeState !== "loading" && (
                <p className="muted">
                  {provider?.id === "offline" ? "WorkRadar drafts" : `${provider?.id === "gemini" ? "Gemini" : "Claude"} drafts`} {reply ? `a reply to ${nameOf(item.author)}` : unblock ? "the note that clears this, with your decision left as a placeholder if it isn't in the item" : "a short message to whoever can move this forward"}, using only what's in this item.
                </p>
              )}
              {nudgeState === "loading" && <div className="skeleton" aria-label="Drafting message"><span /><span /><span /></div>}
              {nudge && nudgeState !== "loading" && (
                <>
                  {nudgeState === "error" && <p className="inline-error"><Icon name="alert" size={14} /> The AI model didn't answer in time, so this is a template draft. Try again in a moment.</p>}
                  <blockquote id="nudge-text" className="nudge-text">{nudge.text}</blockquote>
                  <div className="nudge-foot">
                    <span className="muted">{nudge.by === "ai" ? `Drafted by ${provider?.id === "gemini" ? "Gemini" : provider?.label} in ${nudge.secs?.toFixed(1)}s. Check it before sending.` : "Template draft (no AI model connected)."}</span>
                    <button className="btn btn-quiet btn-sm" onClick={copy}><Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "Copied" : "Copy"}</button>
                  </div>
                </>
              )}
            </section>
          )}

          <section className="panel">
            <header className="panel-head"><h2>Activity</h2></header>
            {item.activity.length ? (
              <ol className="activity">
                {[...item.activity].reverse().map((a, i) => (
                  <li key={i}>
                    <Avatar id={a.who} size={24} />
                    <div><strong>{nameOf(a.who)}</strong> <span className="muted">{ago(a.at, state.now)} · {clock(a.at)}</span><p>{a.text}</p></div>
                  </li>
                ))}
              </ol>
            ) : <p className="muted">No activity recorded at the source yet.</p>}
          </section>
        </div>

        <aside className="detail-side">
          {item.status !== "done" && (
            <section className="panel why">
              <header className="panel-head"><h2>Why it's ranked here</h2><span className={`tier tier-${ranked.tier}`}>{ranked.tier === "now" ? "Now" : ranked.tier === "today" ? "Today" : "Later"} · {ranked.score}</span></header>
              {ranked.reasons.length ? (
                <ul className="why-list">
                  {ranked.reasons.map((r) => (
                    <li key={r.label}>
                      <span className="why-label">{r.label}</span>
                      <span className="why-bar"><span className={`why-fill why-${r.tone}`} style={{ width: `${(r.points / maxPts) * 100}%` }} /></span>
                      <span className="why-pts">+{r.points}</span>
                    </li>
                  ))}
                </ul>
              ) : <p className="muted">No urgency signals. This sits in Later.</p>}
              <p className="muted small">Scores come from fixed rules (severity, blockers, due dates, customer impact), so the same data always ranks the same way.</p>
            </section>
          )}

          <section className="panel">
            <dl className="facts">
              <dt>Owner</dt><dd><Avatar id={item.assignee ?? (item.needsReplyFromMe ? "me" : null)} size={20} /> {item.assignee ? nameOf(item.assignee) : item.needsReplyFromMe ? "You (reply needed)" : "Unassigned"}</dd>
              <dt>Raised by</dt><dd><Avatar id={item.author} size={20} /> {nameOf(item.author)}</dd>
              {item.dueAt && <><dt>Due</dt><dd className={item.dueAt < state.now ? "is-late" : ""}>{dueLabel(item.dueAt, state.now)}</dd></>}
              <dt>Created</dt><dd>{ago(item.createdAt, state.now)}</dd>
              <dt>Updated</dt><dd>{ago(item.updatedAt, state.now)}</dd>
              {item.labels.length > 0 && <><dt>Labels</dt><dd className="labels">{item.labels.map((l) => <span key={l} className="label">{l}</span>)}</dd></>}
            </dl>
          </section>

          {related.length > 0 && (
            <section className="panel">
              <header className="panel-head"><h2>Related</h2></header>
              <ul className="related">
                {related.map((r) => (
                  <li key={r!.id}>
                    <button onClick={() => go({ name: "item", id: r!.id })}>
                      <SourceBadge source={r!.source} />
                      <span className="key">{r!.key}</span>
                      <span className="related-title">{r!.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
