import { Briefing } from "../components/Briefing";
import { Icon } from "../components/Icon";
import { ItemRow } from "../components/ItemRow";
import { Avatar, EmptyState, SourceBadge } from "../components/ui";
import { firstName, manager, nameOf } from "../lib/people";
import { ago, isToday, span } from "../lib/time";
import { useRouter } from "../router";
import { useStore } from "../store";

function greeting(now: number) {
  const h = new Date(now).getHours();
  return h < 5 ? "Working late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

export function Dashboard() {
  const { ranked, items, state } = useStore();
  const { go } = useRouter();

  const now = ranked.filter((r) => r.tier === "now");
  const blocked = ranked.filter((r) => r.item.blocker);
  const onMe = blocked.filter((r) => r.item.blocker!.waitingOn === "me");
  const today = ranked.filter((r) => r.tier !== "now" && !r.item.fyi && (r.item.assignee || r.item.needsReplyFromMe) && r.tier === "today");
  const doneToday = items.filter((i) => i.status === "done" && isToday(i.updatedAt, state.now)).sort((a, b) => b.updatedAt - a.updatedAt);

  const dateLabel = new Date(state.now).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });

  if (!items.length) {
    return (
      <div className="page">
        <header className="page-head">
          <p className="eyebrow">{dateLabel}</p>
          <h1>{greeting(state.now)}, {manager().name.split(" ")[0]}</h1>
        </header>
        {state.loading ? (
          <div className="panel" aria-busy="true">
            <p className="muted">Syncing your sources…</p>
            <div className="skeleton"><span /><span /><span /></div>
          </div>
        ) : state.loadError ? (
          <EmptyState
            art="search"
            title="GitHub data couldn't load"
            body={state.loadError}
          />
        ) : (
          <EmptyState
            title="All clear across your sources"
            body={state.source === "live"
              ? state.live?.sources.length
                ? `Nothing is open in ${state.live.sources.map((s) => s.name).join(", ")}, and nothing finished in the last 24 hours. New work shows up here as it lands.`
                : "No sources yet. Open Sources in the sidebar to add GitHub, Google Calendar, Google Tasks or your own feed."
              : "Nothing is open in Jira, GitHub, Slack or email for your team. WorkRadar will surface new work as soon as it lands."}
            action={<button className="btn btn-primary" onClick={() => go({ name: "search" })}><Icon name="search" size={15} /> Search past work</button>}
          />
        )}
      </div>
    );
  }

  // Timeline of today: source events plus the manager's own actions.
  const timeline = [
    ...doneToday.map((i) => state.overrides[i.id]?.done
      ? { at: i.updatedAt, id: i.id, who: "me", text: `Marked ${i.key} done`, detail: i.title, source: i.source }
      : { at: i.updatedAt, id: i.id, who: i.assignee, text: `${i.kind === "pr" ? "Merged" : i.kind === "deploy" ? "Shipped" : "Closed"} ${i.key}`, detail: i.title, source: i.source }),
    ...state.log.filter((l) => isToday(l.at, state.now) && !l.text.includes("marked")).map((l) => ({ at: l.at, id: l.itemId, who: "me", text: l.text.replace(/^You /, ""), detail: "", source: undefined })),
  ].sort((a, b) => b.at - a.at).slice(0, 8);

  // One row per blocked person: the person waiting, and what they wait on.
  const blockedPeople = blocked.map((r) => {
    const waiting = r.item.assignee ?? r.item.author;
    return { r, waiting, on: r.item.blocker!.waitingOn };
  }).sort((a, b) => (a.on === "me" ? -1 : 0) - (b.on === "me" ? -1 : 0) || a.r.item.blocker!.since - b.r.item.blocker!.since);

  return (
    <div className="page">
      <header className="page-head">
        <p className="eyebrow">{dateLabel}</p>
        <h1>{greeting(state.now)}, {manager().name.split(" ")[0]}</h1>
      </header>

      <nav className="answers" aria-label="Today at a glance">
        <button className="answer answer-now" onClick={() => go({ name: "feed", tab: "now" })}>
          <span className="answer-n">{now.length}</span>
          <span className="answer-q">Need you now</span>
          <span className="answer-sub">{now.filter((r) => r.item.needsReplyFromMe || r.item.blocker?.waitingOn === "me").length} waiting on your reply</span>
        </button>
        <button className="answer answer-blocked" onClick={() => document.getElementById("blocked")?.scrollIntoView({ behavior: "smooth" })}>
          <span className="answer-n">{blockedPeople.length}</span>
          <span className="answer-q">Blocked</span>
          <span className="answer-sub">{onMe.length} blocked on you</span>
        </button>
        <button className="answer answer-today" onClick={() => go({ name: "feed", tab: "today" })}>
          <span className="answer-n">{today.length}</span>
          <span className="answer-q">Top work today</span>
          <span className="answer-sub">in progress or due soon</span>
        </button>
        <button className="answer answer-done" onClick={() => document.getElementById("happened")?.scrollIntoView({ behavior: "smooth" })}>
          <span className="answer-n">{doneToday.length}</span>
          <span className="answer-q">Done today</span>
          <span className="answer-sub">merged, shipped or closed</span>
        </button>
      </nav>

      <Briefing />

      <div className="dash-grid">
        <div className="dash-col">
          <section className="panel">
            <header className="panel-head">
              <h2>Needs attention now</h2>
              <button className="link" onClick={() => go({ name: "feed", tab: "now" })}>Open feed</button>
            </header>
            {now.length ? (
              <div className="rows">{now.slice(0, 5).map((r) => <ItemRow key={r.item.id} r={r} compactActions />)}</div>
            ) : (
              <EmptyState art="clear" title="Nothing urgent" body="No item needs you right now. Top work for today is below." />
            )}
          </section>

          <section className="panel">
            <header className="panel-head">
              <h2>Top work today</h2>
              <button className="link" onClick={() => go({ name: "feed", tab: "today" })}>See all {today.length}</button>
            </header>
            {today.length ? (
              <div className="rows">{today.slice(0, 5).map((r) => <ItemRow key={r.item.id} r={r} compactActions />)}</div>
            ) : (
              <EmptyState art="clear" title="No planned work due today" body="Nothing is due or in progress for today." />
            )}
          </section>
        </div>

        <div className="dash-col">
          <section className="panel" id="blocked">
            <header className="panel-head"><h2>Who's blocked</h2></header>
            {blockedPeople.length ? (
              <ul className="blocked-list">
                {blockedPeople.map(({ r, waiting, on }) => (
                  <li key={r.item.id}>
                    <button className={`blocked-item${on === "me" ? " on-me" : ""}`} onClick={() => go({ name: "item", id: r.item.id })}>
                      <Avatar id={waiting} size={30} />
                      <span className="blocked-main">
                        <span className="blocked-who">
                          <strong>{nameOf(waiting)}</strong>
                          <span className="blocked-for">{span(r.item.blocker!.since, state.now)}</span>
                        </span>
                        <span className="blocked-on">
                          {on === "me" ? "Waiting on you" : on === "unassigned" ? "Waiting on an owner" : `Waiting on ${nameOf(on)}`}
                        </span>
                        <span className="blocked-why">Needs {r.item.blocker!.reason}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState art="clear" title="Nobody is blocked" body="Every open item has what it needs to move." />
            )}
          </section>

          <section className="panel" id="happened">
            <header className="panel-head"><h2>What happened today</h2></header>
            {timeline.length ? (
              <ol className="timeline">
                {timeline.map((t, i) => (
                  <li key={i}>
                    <button className="tl-item" onClick={() => go({ name: "item", id: t.id })}>
                      <span className="tl-time">{ago(t.at, state.now)}</span>
                      <span className="tl-dot" aria-hidden />
                      <span className="tl-body">
                        <span className="tl-text"><strong>{t.who === "me" ? "You" : firstName(t.who)}</strong> {t.text.charAt(0).toLowerCase() + t.text.slice(1)}</span>
                        {t.detail && <span className="tl-detail">{t.detail}</span>}
                      </span>
                      {t.source && <SourceBadge source={t.source} />}
                    </button>
                  </li>
                ))}
              </ol>
            ) : (
              <EmptyState art="clear" title="Quiet so far" body="Merges, deploys and closed tickets from today will show here." />
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
