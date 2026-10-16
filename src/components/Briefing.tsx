import { useEffect, useMemo, useRef, useState } from "react";
import { AiError, detectProvider, generateBriefing, offlineBriefing, type Briefing as B, type Line, type ProviderInfo } from "../lib/ai";
import { clock } from "../lib/time";
import { useRouter } from "../router";
import { useStore } from "../store";
import { Icon } from "./Icon";

type Phase = "detecting" | "loading" | "ready" | "error";

const errorCopy = (code: string, ai: string): string => ({
  not_granted: `${ai} wasn't allowed to run for this page, so you're seeing the rules-based summary.`,
  rate_limited: `${ai} is busy or the free quota is used up for now. Try again in a minute.`,
  session_expired: "Your Claude session expired. Sign in again, then retry.",
  invalid_json: `${ai}'s reply couldn't be read. Retry usually fixes this.`,
  invalid_shape: `${ai}'s reply was missing parts of the briefing. Retry usually fixes this.`,
} as Record<string, string>)[code] ?? `WorkRadar couldn't reach ${ai}. You're seeing the rules-based summary instead.`;

export function Briefing() {
  const { ranked, items, state } = useStore();
  const { go } = useRouter();
  const [provider, setProvider] = useState<ProviderInfo | null>(null);
  const [phase, setPhase] = useState<Phase>("detecting");
  const [ai, setAi] = useState<B | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [at, setAt] = useState<number>(Date.now());
  const ctl = useRef<AbortController | null>(null);

  // Rules-based briefing is always available instantly and is the fallback.
  const offline = useMemo(() => offlineBriefing(ranked, items, state.now), [ranked, items, state.now]);

  // A stable signature of what the briefing is about, so regenerating only
  // happens when the set of open work actually changes.
  const signature = useMemo(
    () => ranked.slice(0, 18).map((r) => `${r.item.id}:${r.tier}:${r.item.assignee}`).join("|") + `#${items.filter((i) => i.status === "done").length}`,
    [ranked, items],
  );

  useEffect(() => { detectProvider().then(setProvider); }, []);

  const run = (fresh = false) => {
    if (!provider) return;
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    if (provider.id === "offline" && !state.aiFails) { setPhase("ready"); setAi(null); setErr(null); setAt(Date.now()); return; }
    setPhase("loading");
    setErr(null);
    generateBriefing(provider.id, ranked, items, { signal: c.signal, forceFail: state.aiFails, fresh })
      .then((b) => { if (!c.signal.aborted) { setAi(b); setPhase("ready"); setAt(Date.now()); } })
      .catch((e: AiError) => {
        if (c.signal.aborted || e.code === "cancelled") return;
        setErr(errorCopy(e.code, aiName));
        setPhase("error");
        setAi(null);
      });
  };

  // Debounce so a burst of actions (assign, done, snooze) triggers one call.
  useEffect(() => {
    if (!provider) return;
    const t = setTimeout(() => run(), 700);
    return () => clearTimeout(t);
  }, [provider, signature, state.aiFails]);

  const aiName = provider?.id === "gemini" ? "Gemini" : provider?.id === "claude-artifact" ? "Claude" : "the AI model";
  const sourceCount = new Set(items.map((i) => i.source)).size;
  const b = ai ?? offline;
  const isAi = !!ai;
  const keyOf = (id: string) => items.find((i) => i.id === id)?.key ?? id;

  const Cite = ({ line }: { line: Line }) => (
    <>
      {line.ids.map((id) => (
        <button key={id} className="cite" onClick={() => go({ name: "item", id })}>{keyOf(id)}</button>
      ))}
    </>
  );

  const Section = ({ title, lines, tone }: { title: string; lines: Line[]; tone: string }) =>
    lines.length ? (
      <section className={`brief-sec brief-${tone}`}>
        <h3>{title}</h3>
        <ul>
          {lines.map((l, i) => (
            <li key={i}><span>{l.text}</span> <Cite line={l} /></li>
          ))}
        </ul>
      </section>
    ) : null;

  return (
    <section className={`briefing${phase === "loading" ? " is-loading" : ""}`} aria-busy={phase === "loading"}>
      <header className="brief-head">
        <span className="brief-label">
          <Icon name="spark" size={15} />
          {isAi ? "AI briefing" : "Today's briefing"}
        </span>
        <span className="brief-prov">
          {phase === "detecting" && "Checking for an AI model…"}
          {phase === "loading" && `${aiName} is reading ${sourceCount} source${sourceCount === 1 ? "" : "s"}…`}
          {phase === "ready" && (isAi ? `Written by ${provider?.label} · ${clock(at)}` : `Rules-based summary · ${clock(at)}`)}
          {phase === "error" && "Rules-based summary"}
        </span>
        <button className="btn btn-quiet btn-sm" onClick={() => run(true)} disabled={phase === "loading" || !provider} title="Regenerate briefing">
          <Icon name="refresh" size={14} /> <span>Regenerate</span>
        </button>
      </header>

      {phase === "error" && err && (
        <div className="brief-error" role="alert">
          <Icon name="alert" size={16} />
          <span>{err}</span>
          <button className="btn btn-quiet btn-sm" onClick={() => run(true)}>Retry</button>
        </div>
      )}

      <p className="brief-headline">{b.headline}</p>

      <div className="brief-grid">
        <Section title="Needs you" lines={b.attention} tone="now" />
        <Section title="Blocked" lines={b.blocked} tone="blocked" />
        <Section title="Done today" lines={b.happened} tone="done" />
      </div>

      <div className="brief-next">
        <span className="brief-next-label">Do next</span>
        <span>{b.suggestion.text} <Cite line={b.suggestion} /></span>
      </div>

      {!isAi && provider?.id === "offline" && phase !== "error" && (
        <p className="brief-note">
          No AI model is connected in this copy, so this briefing is assembled by rules from the ranked items. Run WorkRadar with its server and a free <code>GEMINI_API_KEY</code> (see the README) to have Gemini write it.
        </p>
      )}
    </section>
  );
}
