import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

/**
 * Google sign-in (OAuth 2.0, read-only) for the Calendar and Tasks connectors.
 *
 * One Google account per WorkRadar server. The refresh token is kept in
 * data/google-token.json on the server; the browser never sees any token.
 */

export const GOOGLE_SCOPES = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/tasks.readonly",
];

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface GoogleAppConfig { clientId: string; clientSecret: string; redirectUri: string }

interface StoredToken { refresh_token: string; access_token?: string; expires_at?: number; email?: string }

type Fetch = typeof fetch;

export class GoogleAuth {
  private pendingStates = new Map<string, number>();
  private file: string;

  constructor(private app: GoogleAppConfig | null, dataDir: string, private fetchImpl: Fetch = fetch) {
    this.file = path.join(dataDir, "google-token.json");
  }

  get configured() { return !!this.app; }

  private read(): StoredToken | null {
    try { return existsSync(this.file) ? JSON.parse(readFileSync(this.file, "utf8")) : null; } catch { return null; }
  }
  private write(t: StoredToken | null) {
    mkdirSync(path.dirname(this.file), { recursive: true });
    writeFileSync(this.file, t ? JSON.stringify(t, null, 2) : "{}", { mode: 0o600 });
  }

  status() {
    const t = this.read();
    return { configured: this.configured, connected: !!t?.refresh_token, email: t?.email ?? null };
  }

  /** The URL that starts Google's consent screen. */
  authUrl(): string {
    if (!this.app) throw new Error("Google sign-in isn't set up. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.");
    const state = randomBytes(16).toString("hex");
    const now = Date.now();
    for (const [k, at] of this.pendingStates) if (now - at > 10 * 60_000) this.pendingStates.delete(k);
    this.pendingStates.set(state, now);
    const q = new URLSearchParams({
      client_id: this.app.clientId,
      redirect_uri: this.app.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES.join(" "),
      access_type: "offline", // ask for a refresh token
      prompt: "consent", // so Google returns the refresh token again on reconnect
      include_granted_scopes: "true",
      state,
    });
    return `${AUTH_URL}?${q}`;
  }

  /** Finish sign-in: swap the one-time code for tokens and remember them. */
  async complete(code: string, state: string): Promise<void> {
    if (!this.app) throw new Error("Google sign-in isn't set up.");
    if (!this.pendingStates.delete(state)) throw new Error("This sign-in link expired or was already used. Start again from Sources.");
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code, client_id: this.app.clientId, client_secret: this.app.clientSecret,
        redirect_uri: this.app.redirectUri, grant_type: "authorization_code",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.refresh_token) {
      throw new Error(data.error_description || data.error || "Google didn't return a refresh token. Remove WorkRadar's access in your Google account settings and connect again.");
    }
    this.write({
      refresh_token: data.refresh_token,
      access_token: data.access_token,
      expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      email: emailFromIdToken(data.id_token),
    });
  }

  disconnect() { this.write(null); }

  /** A valid access token, refreshed when it is about to expire. */
  async accessToken(): Promise<string> {
    if (!this.app) throw new Error("Google sign-in isn't set up. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to .env.");
    const t = this.read();
    if (!t?.refresh_token) throw new Error("Google isn't connected. Open Sources and choose Connect Google.");
    if (t.access_token && t.expires_at && t.expires_at - Date.now() > 60_000) return t.access_token;
    const res = await this.fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.app.clientId, client_secret: this.app.clientSecret,
        refresh_token: t.refresh_token, grant_type: "refresh_token",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.access_token) {
      if (data.error === "invalid_grant") {
        this.write(null);
        throw new Error("Google access was revoked or expired. Connect Google again from Sources.");
      }
      throw new Error(data.error_description || `Google token refresh failed (${res.status}).`);
    }
    this.write({ ...t, access_token: data.access_token, expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000 });
    return data.access_token;
  }
}

/** The email claim from Google's ID token (no signature check needed: it came straight from Google over TLS). */
function emailFromIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : undefined;
  } catch {
    return undefined;
  }
}
