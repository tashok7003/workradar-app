import { useEffect, useState } from "react";
import { Icon, RadarMark } from "./components/Icon";
import { Avatar, Banner, Popover, ToastProvider, useToast } from "./components/ui";
import { manager } from "./lib/people";
import { MOCK_SOURCES, sourceColor, sourceLabel } from "./lib/sources";
import { ago } from "./lib/time";
import { Sources } from "./pages/Sources";
import { Dashboard } from "./pages/Dashboard";
import { Feed } from "./pages/Feed";
import { ItemDetail } from "./pages/ItemDetail";
import { Search } from "./pages/Search";
import { RouterProvider, useRouter } from "./router";
import { StoreProvider, useStore } from "./store";
import type { Source } from "./types";

function Shell() {
  const { route, go } = useRouter();
  const { ranked, snoozed, state, sources, sourceIds, server, checkServer, setHealth, setAiFails, setEmpty, setSource, refresh, reset } = useStore();
  const toast = useToast();
  const [retrying, setRetrying] = useState<Source | null>(null);
  const nowCount = ranked.filter((r) => r.tier === "now").length;
  const live = state.source === "live";
  const down = sourceIds.filter((s) => sources[s] === "error");
  const errorOf = (id: string) => state.live?.sources.find((x) => x.id === id)?.error;

  // Back from Google's sign-in page: open Sources and say how it went.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const g = q.get("google");
    if (!g) return;
    window.history.replaceState(null, "", window.location.pathname);
    go({ name: "sources" });
    toast({ text: g === "connected" ? "Google connected. Add a Calendar or Tasks source." : `Google sign-in didn't finish: ${g}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // "/" jumps to search from anywhere, as in most work tools.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (e.key === "/" && !/input|textarea|select/i.test(t.tagName)) { e.preventDefault(); go({ name: "search" }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const retry = (s: Source) => {
    if (live) { refresh(); return; }
    setRetrying(s);
    // Mock reconnect: a real build would re-run the source sync here.
    setTimeout(() => { setHealth(s, true); setRetrying(null); }, 1200);
  };

  const nav = [
    { id: "dashboard", label: "Dashboard", icon: "home", on: route.name === "dashboard", go: () => go({ name: "dashboard" }) },
    { id: "feed", label: "Priority feed", icon: "feed", on: route.name === "feed" && route.tab !== "snoozed", go: () => go({ name: "feed", tab: "now" }), n: nowCount },
    { id: "search", label: "Search", icon: "search", on: route.name === "search", go: () => go({ name: "search" }), kbd: "/" },
    { id: "snoozed", label: "Snoozed", icon: "snooze", on: route.name === "feed" && route.tab === "snoozed", go: () => go({ name: "feed", tab: "snoozed" }), n: snoozed.length || undefined },
    { id: "sources", label: "Sources", icon: "link", on: route.name === "sources", go: () => go({ name: "sources" }) },
  ];

  return (
    <div className="app">
      <aside className="rail">
        <div className="brand">
          <RadarMark />
          <span>WorkRadar</span>
        </div>

        <nav className="nav" aria-label="Main">
          {nav.map((n) => (
            <button key={n.id} className={`nav-item${n.on ? " is-on" : ""}`} onClick={n.go} aria-current={n.on ? "page" : undefined}>
              <Icon name={n.icon} size={18} />
              <span className="nav-label">{n.label}</span>
              {n.n ? <span className="nav-n">{n.n}</span> : n.kbd ? <kbd>{n.kbd}</kbd> : null}
            </button>
          ))}
        </nav>

        <section className="sources" aria-label="Connected sources">
          <h2>{live ? "Your sources" : "Sources (demo)"}</h2>
          <ul>
            {sourceIds.map((s) => (
              <li key={s} className={sources[s] === "error" ? "is-down" : sources[s] === "off" ? "is-off" : ""}>
                <span className={`dot dot-${sources[s] === "error" ? "error" : sources[s] === "off" ? "off" : "ok"}`} style={sources[s] === "ok" ? { background: sourceColor(s) } : undefined} />
                <span className="src-name">{sourceLabel(s)}</span>
                <span className="src-state">
                  {retrying === s || sources[s] === "loading" ? "Syncing…"
                    : sources[s] === "error" ? "Sync failed"
                    : live && state.live ? ago(state.live.fetchedAt, state.now) : "Mock data"}
                </span>
              </li>
            ))}
            {live && !state.loading && sourceIds.length === 0 && (
              <li><button className="link" onClick={() => go({ name: "sources" })}>Add your first source</button></li>
            )}
          </ul>
        </section>

        <div className="rail-foot">
          <Popover
            align="start"
            trigger={(toggle, open) => (
              <button className="btn btn-quiet btn-sm demo-btn" onClick={() => { if (!open) void checkServer(); toggle(); }} aria-expanded={open}>
                <Icon name="sliders" size={14} /> <span>Demo controls</span>
              </button>
            )}
          >
            {() => (
              <div className="demo">
                <div className="pop-title">Data</div>
                <label className="toggle">
                  <input id="demo-src-mock" type="radio" name="demo-src" checked={!live} onChange={() => setSource("mock")} />
                  Mock team (demo data)
                </label>
                <label className={`toggle${server ? "" : " is-disabled"}`}>
                  <input id="demo-src-live" type="radio" name="demo-src" disabled={!server} checked={live} onChange={() => setSource("live")} />
                  <span>Your sources{server ? ` (${server.sources.length} connected)` : <small> · API not reachable: run <code>npm run dev</code></small>}</span>
                </label>
                <div className="pop-title">Simulate states for review</div>
                {!live && MOCK_SOURCES.map((s) => (
                  <label key={s} className="toggle">
                    <input id={`demo-${s}`} type="checkbox" checked={state.health[s] === "error"} onChange={(e) => setHealth(s, !e.target.checked)} />
                    {sourceLabel(s)} sync fails
                  </label>
                ))}
                <label className="toggle">
                  <input id="demo-ai" type="checkbox" checked={state.aiFails} onChange={(e) => setAiFails(e.target.checked)} />
                  AI request fails
                </label>
                <label className="toggle">
                  <input id="demo-empty" type="checkbox" checked={state.emptyWorkspace} onChange={(e) => setEmpty(e.target.checked)} />
                  Empty workspace
                </label>
                <button className="pop-item pop-item-muted" onClick={reset}>Reset demo data</button>
              </div>
            )}
          </Popover>
          <div className="me">
            <Avatar id="me" size={28} />
            <span><strong>{manager().name}</strong><small>{manager().role}</small></span>
          </div>
        </div>
      </aside>

      <main className="main">
        {live && state.loadError && (
          <div className="banners">
            <Banner tone="error" title="Your sources couldn't load" action={<button className="btn btn-quiet btn-sm" onClick={refresh}><Icon name="refresh" size={14} /> Retry</button>}>
              {state.loadError}
            </Banner>
          </div>
        )}
        {down.length > 0 && (
          <div className="banners">
            {down.map((s) => (
              <Banner
                key={s}
                tone="error"
                title={`${sourceLabel(s)} didn't sync`}
                action={<button className="btn btn-quiet btn-sm" onClick={() => retry(s)} disabled={retrying === s || state.loading}><Icon name="refresh" size={14} /> {retrying === s || state.loading ? "Retrying…" : "Retry"}</button>}
              >
                {live && errorOf(s) ? errorOf(s) : `Items from ${sourceLabel(s)} are missing from the feed, briefing and search until it reconnects.`}
              </Banner>
            ))}
          </div>
        )}
        {route.name === "dashboard" && <Dashboard />}
        {route.name === "feed" && <Feed tab={route.tab} />}
        {route.name === "item" && <ItemDetail id={route.id} />}
        {route.name === "search" && <Search initial={route.q} />}
        {route.name === "sources" && <Sources />}
      </main>
    </div>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <RouterProvider>
        <ToastProvider>
          <Shell />
        </ToastProvider>
      </RouterProvider>
    </StoreProvider>
  );
}
