import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Icon } from "../components/Icon";
import { Banner, EmptyState, useToast } from "../components/ui";
import { TYPE_COLOR, TYPE_LABEL } from "../lib/sources";
import { useStore } from "../store";
import type { ConnectorType } from "../types";

// ---- API shapes (mirror server/connectors) -----------------------------------------

interface FieldSpec {
  key: string; label: string; help?: string; placeholder?: string; required?: boolean;
  kind: "text" | "textarea" | "secret" | "select" | "number" | "boolean";
  options?: { value: string; label: string }[]; default?: unknown;
}
interface CatalogEntry { type: ConnectorType; label: string; description: string; needsGoogle: boolean; fields: FieldSpec[] }
interface Connector { id: string; type: ConnectorType; name: string; enabled: boolean; settings: Record<string, unknown>; secretsSet: Record<string, boolean> }
interface GoogleStatus { configured: boolean; connected: boolean; email: string | null }
interface Listing { connectors: Connector[]; catalog: CatalogEntry[]; google: GoogleStatus; publicUrl: string }
interface TestResult { count: number; sample: { title: string; status: string; owner: string | null; due: number | null; url?: string }[] }

const TOKEN_KEY = "workradar.adminToken";
const readToken = () => { try { return localStorage.getItem(TOKEN_KEY) ?? ""; } catch { return ""; } };

class ApiError extends Error { constructor(message: string, public status: number) { super(message); } }

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = readToken();
  const res = await fetch(`api/${path}`, {
    ...init,
    headers: { accept: "application/json", ...(init.body ? { "content-type": "application/json" } : {}), ...(token ? { "x-admin-token": token } : {}), ...init.headers },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.message || `Request failed (${res.status})`, res.status);
  return body as T;
}

// ---- page ---------------------------------------------------------------------------

export function Sources() {
  const { server, refresh, state, setSource, checkServer } = useStore();
  const toast = useToast();
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [editing, setEditing] = useState<{ def: CatalogEntry; existing?: Connector } | null>(null);
  const [picking, setPicking] = useState(false);
  const [secret, setSecret] = useState<{ id: string; secret: string } | null>(null);
  const [token, setToken] = useState(readToken());

  const load = useCallback(() => {
    api<Listing>("connectors").then((d) => { setData(d); setError(null); }).catch((e: ApiError) => setError(e));
  }, []);
  useEffect(() => { if (server) load(); }, [server, load]);

  /** After any change: reload the list, and pull fresh items into the app. */
  const changed = () => {
    load();
    checkServer();
    if (state.source === "live") refresh(); else setSource("live");
  };

  if (!server) {
    return (
      <div className="page">
        <Head />
        <EmptyState art="search" title="The WorkRadar server isn't running" body="Sources are stored and synced by the server, so it has to be running. Start it with npm run dev (or npm start after a build), then reload this page." />
      </div>
    );
  }

  const forbidden = error?.status === 403;

  return (
    <div className="page sources-page">
      <Head />

      {forbidden && (
        <form className="card token-card" onSubmit={(e) => { e.preventDefault(); try { localStorage.setItem(TOKEN_KEY, token.trim()); } catch { /* private mode */ } load(); }}>
          <h2>Admin token needed</h2>
          <p className="muted">{error?.message}</p>
          <div className="row">
            <label className="sr" htmlFor="admin-token">Admin token</label>
            <input id="admin-token" className="input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="ADMIN_TOKEN from the server's .env" />
            <button className="btn btn-primary">Unlock</button>
          </div>
        </form>
      )}
      {error && !forbidden && <Banner tone="error" title="Couldn't load sources">{error.message}</Banner>}

      {data && (
        <>
          <GoogleCard google={data.google} publicUrl={data.publicUrl} onChange={() => { load(); changed(); }} />

          {secret && (
            <WebhookHelp id={secret.id} secret={secret.secret} publicUrl={data.publicUrl} onClose={() => setSecret(null)} />
          )}

          <section className="card">
            <div className="card-head">
              <h2>Connected sources</h2>
              <button className="btn btn-primary btn-sm" onClick={() => { setPicking(true); setEditing(null); }}><Icon name="link" size={14} /> Add source</button>
            </div>

            {picking && !editing && (
              <div className="type-grid" role="list">
                {data.catalog.map((c) => {
                  const blocked = c.needsGoogle && !data.google.connected;
                  return (
                    <button key={c.type} role="listitem" className="type-card" style={{ ["--src" as string]: TYPE_COLOR[c.type] }} disabled={blocked} onClick={() => setEditing({ def: c })}>
                      <span className="src">{c.label}</span>
                      <span className="type-desc">{c.description}</span>
                      {blocked && <small className="muted">Connect Google above first</small>}
                    </button>
                  );
                })}
                <button className="link" onClick={() => setPicking(false)}>Cancel</button>
              </div>
            )}

            {editing && (
              <ConnectorForm
                def={editing.def}
                existing={editing.existing}
                onCancel={() => { setEditing(null); setPicking(false); }}
                onSaved={(c, hookSecret) => {
                  setEditing(null); setPicking(false);
                  if (hookSecret) setSecret({ id: c.id, secret: hookSecret });
                  toast({ text: editing.existing ? `Saved ${c.name}` : `Added ${c.name}` });
                  changed();
                }}
              />
            )}

            {data.connectors.length === 0 && !picking && (
              <p className="muted empty-line">No sources yet. Add GitHub, Google Calendar, Google Tasks, any JSON feed, or a webhook that other tools post to.</p>
            )}

            <ul className="conn-list">
              {data.connectors.map((c) => {
                const def = data.catalog.find((d) => d.type === c.type)!;
                const live = state.live?.sources.find((s) => s.id === c.id);
                return (
                  <li key={c.id} className={`conn${c.enabled ? "" : " is-off"}`}>
                    <span className="dot" style={{ background: c.enabled ? TYPE_COLOR[c.type] : "var(--ink-3)" }} />
                    <div className="conn-main">
                      <strong>{c.name}</strong>
                      <span className="muted"> · {TYPE_LABEL[c.type]}</span>
                      <div className="conn-state">
                        {!c.enabled ? "Paused"
                          : live?.status === "error" ? <span className="text-critical">Sync failed: {live.error}</span>
                          : live ? `${live.count} item${live.count === 1 ? "" : "s"}`
                          : "Not synced yet"}
                      </div>
                    </div>
                    <div className="conn-actions">
                      {c.type === "webhook" && (
                        <button className="btn btn-quiet btn-sm" onClick={() => setSecret({ id: c.id, secret: "" })}>How to post</button>
                      )}
                      <label className="switch" title={c.enabled ? "Pause this source" : "Resume this source"}>
                        <input type="checkbox" checked={c.enabled} aria-label={`${c.name} enabled`} onChange={(e) => {
                          api(`connectors/${c.id}`, { method: "PATCH", body: JSON.stringify({ enabled: e.target.checked }) }).then(changed).catch((err: Error) => toast({ text: err.message }));
                        }} />
                        <span />
                      </label>
                      <button className="btn btn-quiet btn-sm" onClick={() => { setPicking(false); setEditing({ def, existing: c }); }}>Edit</button>
                      <button className="btn btn-quiet btn-sm" onClick={() => {
                        if (!window.confirm(`Remove ${c.name}? Its items leave your feed.`)) return;
                        api(`connectors/${c.id}`, { method: "DELETE" }).then(() => { toast({ text: `Removed ${c.name}` }); changed(); }).catch((err: Error) => toast({ text: err.message }));
                      }}>Remove</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

function Head() {
  return (
    <header className="page-head">
      <p className="eyebrow">Where your work comes from</p>
      <h1>Sources</h1>
      <p className="muted">Each source is read-only. WorkRadar pulls items in, ranks them, and links back to where they live.</p>
    </header>
  );
}

// ---- Google -------------------------------------------------------------------------

function GoogleCard({ google, publicUrl, onChange }: { google: GoogleStatus; publicUrl: string; onChange: () => void }) {
  const toast = useToast();
  const token = readToken();
  const start = `api/auth/google/start${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  return (
    <section className="card google-card">
      <div className="card-head">
        <h2>Google account</h2>
        {google.connected
          ? <button className="btn btn-quiet btn-sm" onClick={() => api("auth/google/disconnect", { method: "POST" }).then(() => { toast({ text: "Google disconnected" }); onChange(); })}>Disconnect</button>
          : google.configured && <a className="btn btn-primary btn-sm" href={start}>Connect Google</a>}
      </div>
      {google.connected ? (
        <p>Connected as <strong>{google.email ?? "your Google account"}</strong>. Calendar and Tasks sources read from this account (read-only).</p>
      ) : google.configured ? (
        <p className="muted">Connect once to add Google Calendar and Google Tasks sources. WorkRadar asks only for read-only access.</p>
      ) : (
        <details className="setup">
          <summary>Google isn't set up on this server yet. How to set it up (about 5 minutes)</summary>
          <ol>
            <li>Open <a href="https://console.cloud.google.com/" target="_blank" rel="noreferrer">Google Cloud Console</a> and create a project.</li>
            <li>Under <em>APIs &amp; Services → Library</em>, enable <strong>Google Calendar API</strong> and <strong>Google Tasks API</strong>.</li>
            <li>Under <em>OAuth consent screen</em>, choose External, keep it in Testing, and add your own Gmail as a test user.</li>
            <li>Under <em>Credentials</em>, create an <strong>OAuth client ID</strong> of type Web application, with this redirect URI:<br /><code>{publicUrl}/api/auth/google/callback</code></li>
            <li>Put the client ID and secret in <code>.env</code> as <code>GOOGLE_CLIENT_ID</code> and <code>GOOGLE_CLIENT_SECRET</code>, then restart the server.</li>
          </ol>
        </details>
      )}
    </section>
  );
}

// ---- add / edit form ----------------------------------------------------------------

function ConnectorForm({ def, existing, onCancel, onSaved }: {
  def: CatalogEntry; existing?: Connector;
  onCancel: () => void; onSaved: (c: Connector, webhookSecret?: string) => void;
}) {
  const [name, setName] = useState(existing?.name ?? def.label);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const f of def.fields) v[f.key] = existing?.settings[f.key] ?? f.default ?? (f.kind === "boolean" ? false : "");
    return v;
  });
  const [busy, setBusy] = useState<"" | "test" | "save">("");
  const [problem, setProblem] = useState("");
  const [test, setTest] = useState<TestResult | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const set = (k: string, v: unknown) => { setValues((cur) => ({ ...cur, [k]: v })); setTest(null); };
  const basic = def.fields.filter((f) => f.required || !f.key.startsWith("f_"));
  const advanced = def.fields.filter((f) => !f.required && f.key.startsWith("f_"));

  const runTest = () => {
    setBusy("test"); setProblem("");
    api<TestResult>("connectors/test", { method: "POST", body: JSON.stringify({ type: def.type, settings: values, id: existing?.id }) })
      .then(setTest).catch((e: Error) => setProblem(e.message)).finally(() => setBusy(""));
  };

  const save = (e: FormEvent) => {
    e.preventDefault();
    setBusy("save"); setProblem("");
    const req = existing
      ? api<{ connector: Connector }>(`connectors/${existing.id}`, { method: "PATCH", body: JSON.stringify({ name, settings: values }) })
      : api<{ connector: Connector; webhookSecret?: string }>("connectors", { method: "POST", body: JSON.stringify({ type: def.type, name, settings: values }) });
    req.then((r) => onSaved(r.connector, (r as { webhookSecret?: string }).webhookSecret))
      .catch((err: Error) => setProblem(err.message)).finally(() => setBusy(""));
  };

  const field = (f: FieldSpec) => {
    const id = `cf-${f.key}`;
    const v = values[f.key];
    const secretSet = f.kind === "secret" && existing?.secretsSet[f.key];
    return (
      <div className="field" key={f.key}>
        {f.kind === "boolean" ? (
          <label className="check"><input id={id} type="checkbox" checked={!!v} onChange={(e) => set(f.key, e.target.checked)} /> {f.label}</label>
        ) : (
          <>
            <label htmlFor={id}>{f.label}{f.required && <span className="req"> *</span>}</label>
            {f.kind === "select" ? (
              <select id={id} className="input" value={String(v ?? "")} onChange={(e) => set(f.key, e.target.value)}>
                {f.options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : f.kind === "textarea" ? (
              <textarea id={id} className="input" rows={3} value={String(v ?? "")} placeholder={f.placeholder} onChange={(e) => set(f.key, e.target.value)} />
            ) : (
              <input id={id} className="input" autoComplete="off"
                type={f.kind === "secret" ? "password" : f.kind === "number" ? "number" : "text"}
                value={String(v ?? "")}
                placeholder={secretSet ? "Saved. Leave blank to keep it." : f.placeholder}
                onChange={(e) => set(f.key, f.kind === "number" ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)} />
            )}
          </>
        )}
        {f.help && <small className="muted">{f.help}</small>}
      </div>
    );
  };

  return (
    <form className="conn-form" onSubmit={save} style={{ ["--src" as string]: TYPE_COLOR[def.type] }}>
      <h3><span className="src">{def.label}</span> {existing ? `Edit ${existing.name}` : "New source"}</h3>
      <p className="muted">{def.description}</p>
      <div className="field">
        <label htmlFor="cf-name">Name in WorkRadar</label>
        <input id="cf-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      {basic.map(field)}
      {advanced.length > 0 && (
        <>
          <button type="button" className="link" onClick={() => setShowAdvanced((x) => !x)}>
            {showAdvanced ? "Hide field mapping" : "Field mapping (when your feed uses different names)"}
          </button>
          {showAdvanced && <div className="field-grid">{advanced.map(field)}</div>}
        </>
      )}

      {problem && <p className="inline-error"><Icon name="alert" size={14} /> {problem}</p>}
      {test && (
        <div className="test-result">
          <p><Icon name="check" size={14} /> Found <strong>{test.count}</strong> item{test.count === 1 ? "" : "s"}{test.count > 0 ? ". First few:" : ". The connection works but nothing matched yet."}</p>
          {test.sample.length > 0 && (
            <ul>{test.sample.map((s, i) => <li key={i}><span className="muted">[{s.status.replace("_", " ")}]</span> {s.title}{s.due ? <span className="muted"> · due {new Date(s.due).toLocaleString()}</span> : null}</li>)}</ul>
          )}
        </div>
      )}

      <div className="row">
        <button type="submit" className="btn btn-primary" disabled={!!busy}>{busy === "save" ? "Saving…" : existing ? "Save" : "Add source"}</button>
        {def.type !== "webhook" && <button type="button" className="btn btn-quiet" disabled={!!busy} onClick={runTest}>{busy === "test" ? "Testing…" : "Test connection"}</button>}
        <button type="button" className="link" onClick={onCancel}>Cancel</button>
      </div>
    </form>
  );
}

// ---- webhook instructions -----------------------------------------------------------

function WebhookHelp({ id, secret, publicUrl, onClose }: { id: string; secret: string; publicUrl: string; onClose: () => void }) {
  const toast = useToast();
  const url = `${publicUrl}/api/hooks/${id}`;
  const curl = `curl -X POST ${url} \\
  -H "Content-Type: application/json" \\
  -H "X-WorkRadar-Secret: ${secret || "<your secret>"}" \\
  -d '{"id":"INV-42","title":"Approve vendor invoice","status":"open","due":"2026-10-20","url":"https://example.com/inv/42","priority":"high"}'`;
  const copy = (text: string, what: string) => navigator.clipboard?.writeText(text).then(() => toast({ text: `Copied ${what}` }), () => toast({ text: "Couldn't copy. Select the text instead." }));
  return (
    <section className="card hook-card">
      <div className="card-head">
        <h2>Post items to this webhook</h2>
        <button className="icon-btn" onClick={onClose} aria-label="Close"><Icon name="x" size={16} /></button>
      </div>
      {secret ? (
        <Banner tone="warning" title="Copy the secret now">It's shown only once. If you lose it, remove the source and add it again.</Banner>
      ) : (
        <p className="muted">The secret was shown when you created this source.</p>
      )}
      <dl className="kv">
        <dt>URL</dt><dd><code>{url}</code> <button className="btn btn-quiet btn-sm" onClick={() => copy(url, "URL")}><Icon name="copy" size={13} /></button></dd>
        {secret && <><dt>Secret</dt><dd><code>{secret}</code> <button className="btn btn-quiet btn-sm" onClick={() => copy(secret, "secret")}><Icon name="copy" size={13} /></button></dd></>}
      </dl>
      <p className="muted">Send one item or an array. Sending the same <code>id</code> again updates it; <code>"status":"done"</code> closes it. Fields: id, title, description, status, owner, due, url, priority, blocked.</p>
      <pre className="code">{curl}</pre>
      <button className="btn btn-quiet btn-sm" onClick={() => copy(curl, "example")}><Icon name="copy" size={13} /> Copy example</button>
      {publicUrl.includes("localhost") && <p className="muted">This URL only works on your computer. To receive posts from Zapier, Make or other tools, deploy WorkRadar and set PUBLIC_URL.</p>}
    </section>
  );
}
