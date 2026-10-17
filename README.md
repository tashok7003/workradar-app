# WorkRadar App

The full-stack version of WorkRadar: one screen that tells an engineering manager what needs them now, what their team is working on today, who is blocked, and what already happened, without opening Jira, GitHub, Slack and email separately.

It adds a Node API server, pluggable live sources (GitHub, Google Calendar, Google Tasks, any JSON feed, webhooks) and AI briefings from Google Gemini (free tier) to the original case-study prototype. The prototype, its PRD and AI Workflow documents, and its static live demo stay unchanged in [tashok7003/workradar](https://github.com/tashok7003/workradar) ([live demo](https://tashok7003.github.io/workradar/)).

## What runs where

| Mode | Data | AI briefing and drafts | How to get it |
|---|---|---|---|
| Static build (no server) | Mock team across Jira, GitHub, Slack, email | Rules-based, labelled as such | `npm run build`, host `dist/` anywhere |
| Full app (local or Render) | Mock team **or your own sources** (add them on the Sources page) | **Google Gemini** (free tier) | `npm run dev` with a `.env` |
| Inside Claude (hosted artifact) | Mock team | Claude, on the viewer's account | Open the Claude artifact link |

## Run the full app

Requires Node 20.12 or newer (check with `node -v`).

```bash
npm install
cp .env.example .env     # then fill in the values below
npm run dev              # web on http://localhost:5173, API on :8787
```

What to put in `.env`:

1. **`GEMINI_API_KEY`**: free key from [Google AI Studio](https://aistudio.google.com/apikey). This turns on the AI briefing and the "Draft a reply / nudge" button.
2. **`GITHUB_REPOS`**: the repositories to watch, e.g. `tashok7003/workradar-app,tashok7003/raptric-connect`.
3. **`GITHUB_MANAGER`**: your GitHub login. Review requests to you, `@mentions` and "blocked on @you" show as blocked on you.
4. **`GITHUB_TOKEN`** (recommended): a fine-grained token with read-only access to Metadata, Issues, Pull requests and Checks. Without it GitHub allows 60 requests an hour.
5. **`GITHUB_TEAM`** (optional): display names, e.g. `tashok7003:Ashok:Engineering manager,octocat:Mona:Backend`.

Then open **Sources** in the sidebar to add more, or **Demo controls → Data → Your sources** to switch from mock data. The `GITHUB_*` values only seed your first GitHub source; after that, manage everything on the Sources page.

Nothing is required: with no `.env`, the app runs on mock data with the rules-based briefing.

### Deploy the full app for free

`render.yaml` deploys UI and API as one service on Render's free plan: Render → New → Blueprint → this repo, then paste the same values. (The free plan sleeps when idle; the first request after a pause takes about 30 seconds.)

## Sources (connectors)

Open **Sources** in the sidebar. Each source is read-only, can be paused, edited, tested before saving, or removed, and failing ones never hide the others. Settings are saved on the server in `data/connectors.json`; tokens and secrets never go back to the browser.

| Source | What becomes a work item |
|---|---|
| **GitHub** | Issues, pull requests, review requests, blockers, CI (table below) |
| **Google Calendar** | Events someone else put on your calendar (optionally only from your manager's email), or only events with a title marker like `[task]`. The start time is the due time; an invite you haven't answered counts as waiting on you. Declined events, focus time, out-of-office and birthdays are skipped. |
| **Google Tasks** | Open tasks from all or chosen lists, with due dates. Tasks assigned to you from Google Docs or Chat show where they came from. |
| **JSON feed** | Any URL that returns JSON: an internal API, a Jira search, a Notion export, a script. Point fields at your data with dot paths. |
| **Webhook** | Anything that can POST JSON (Zapier, Make, n8n, a cron script) pushes items in. |

Sources can only be changed from the computer running WorkRadar unless you set `ADMIN_TOKEN`; then the Sources page asks for it.

### Google setup (Calendar and Tasks)

1. In [Google Cloud Console](https://console.cloud.google.com/), create a project.
2. **APIs & Services → Library**: enable **Google Calendar API** and **Google Tasks API**.
3. **OAuth consent screen**: External, leave it in *Testing*, and add your own Gmail under *Test users*.
4. **Credentials → Create credentials → OAuth client ID → Web application**. Authorised redirect URI: `http://localhost:5173/api/auth/google/callback` (on Render: `https://<your-app>.onrender.com/api/auth/google/callback`).
5. Put the values in `.env` as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (and `PUBLIC_URL` if not localhost), then restart `npm run dev`.
6. Sources → **Connect Google** → allow read-only access → **Add source → Google Calendar / Google Tasks**.

WorkRadar asks only for `calendar.readonly` and `tasks.readonly`. The refresh token is stored in `data/google-token.json`; **Disconnect** deletes it.

### JSON feed example: Jira

URL `https://your-site.atlassian.net/rest/api/3/search?jql=assignee=currentUser() AND statusCategory!=Done`, Auth header `Authorization: Basic <base64 of email:api-token>`, Items path `issues`, then under field mapping: title `fields.summary`, id `key`, status `fields.status.name`, owner `fields.assignee.displayName`, due `fields.duedate`, priority `fields.priority.name`.

The feed URL must be public internet in production (private and local addresses are refused unless `ALLOW_PRIVATE_FEEDS=1`).

### Webhook format

`POST /api/hooks/<source-id>` with header `X-WorkRadar-Secret: <secret shown once when you add the source>` and one item or an array:

```json
{ "id": "INV-42", "title": "Approve vendor invoice", "status": "open", "due": "2026-10-20",
  "owner": "you@company.com", "priority": "high", "blocked": false, "url": "https://…", "description": "…" }
```

Posting the same `id` again updates the item; `"status": "done"` closes it. Up to 500 items per webhook are kept.

## What the GitHub source reads

| GitHub | Becomes in WorkRadar |
|---|---|
| Open issues | Tickets. Labels set severity (`p0`–`p3`, `critical`, `high`, `bug`, `low`) and tags (`security`, `customer…`, `incident`). Milestone due date becomes the due date. |
| "Blocked by @user / #12" in an issue, or a `blocked` label | A blocker with who or what it waits on |
| `@you` in an issue body | "Waiting on your reply" |
| Open pull requests | PRs. Review requested from you means blocked on you; from someone else for over 24h means blocked on them. |
| Check runs on the PR's latest commit | "CI failing" |
| `fixes #12` in a PR | Linked both ways with the issue |
| PRs merged and issues closed in the last 24h | "What happened today" |

## How it works

```
GitHub, Google Calendar, ─┐                         ┌─► rank() (deterministic, explained) ─► UI
Google Tasks, JSON feeds, ├─► server (/api) ─► store┤
webhooks · or mock data ──┘   holds all keys        └─► briefing context ─► server ─► Gemini ─► validate citations ─► UI
                                                                      └─► rules-based fallback
```

- **Rules rank, AI explains.** Priority scores are deterministic, so the order is stable and every point is visible. Gemini only summarises the ranked list and drafts messages.
- **Keys stay on the server.** The browser never sees the Gemini key or GitHub token. The server builds AI prompts from structured data itself, so it is not an open proxy; it also rate-limits AI calls per visitor and caches identical requests for 10 minutes to stay inside the free quota.
- **Citations are validated.** Any item id Gemini invents is dropped before the briefing renders.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | API server and web app together, with reload |
| `npm start` | Production server: API plus the built app from `dist/` |
| `npm test` | 47 tests: ranking, search, AI validation, every connector's mapping, Google sign-in, Sources API, Gemini client, API routes |
| `npm run build` | Type-check and build the web app to `dist/` |
| `npm run build:single` | One self-contained HTML file for the Claude-hosted demo |

Every push and pull request runs the tests and the build (`.github/workflows/ci.yml`).

## Project layout

```
server/
  app.ts            API routes, rate limit, caches; serves dist/ in production
  connectors/       one file per source type (github, google, custom feed + webhook),
                    the saved-sources store and the workspace builder
  google-auth.ts    Google OAuth sign-in and token refresh
  github.ts         GitHub REST client and the mapping to WorkItem
  gemini.ts         Gemini client (Interactions API, falls back to generateContent)
  config.ts         environment parsing
src/
  data/mock.ts      mock team and 27 work items
  lib/priority.ts   scoring rules and tiers
  lib/ai.ts         provider detection, validation, rules-based fallback
  lib/prompts.ts    prompt builders shared by browser and server
  lib/search.ts     weighted multi-field search and highlighting
  store.tsx         state, data source switch, actions, persistence
  lib/sources.ts    labels and colours for sources
  pages/            Dashboard, Feed, ItemDetail, Search, Sources
```

## Not built yet

Login and a database (actions are saved in the browser; sources in a JSON file on the server), write-back to sources (Assign / Done change WorkRadar only), and native Slack and email connectors (a JSON feed or webhook can bridge them today).
