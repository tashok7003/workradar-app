# WorkRadar App

The full-stack version of WorkRadar: one screen that tells an engineering manager what needs them now, what their team is working on today, who is blocked, and what already happened, without opening Jira, GitHub, Slack and email separately.

It adds a Node API server, live GitHub data and AI briefings from Google Gemini (free tier) to the original case-study prototype. The prototype, its PRD and AI Workflow documents, and its static live demo stay unchanged in [tashok7003/workradar](https://github.com/tashok7003/workradar) ([live demo](https://tashok7003.github.io/workradar/)).

## What runs where

| Mode | Data | AI briefing and drafts | How to get it |
|---|---|---|---|
| Static build (no server) | Mock team across Jira, GitHub, Slack, email | Rules-based, labelled as such | `npm run build`, host `dist/` anywhere |
| Full app (local or Render) | Mock team **or live GitHub** (switch in Demo controls) | **Google Gemini** (free tier) | `npm run dev` with a `.env` |
| Inside Claude (hosted artifact) | Mock team | Claude, on the viewer's account | Open the Claude artifact link |

## Run the full app

Requires Node 20.6 or newer.

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

Then open **Demo controls → Data → Live GitHub**.

Nothing is required: with no `.env`, the app runs on mock data with the rules-based briefing.

### Deploy the full app for free

`render.yaml` deploys UI and API as one service on Render's free plan: Render → New → Blueprint → this repo, then paste the same values. (The free plan sleeps when idle; the first request after a pause takes about 30 seconds.)

## What the live GitHub connector reads

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
GitHub API ─┐                         ┌─► rank() (deterministic, explained) ─► UI
            ├─► server (/api) ─► store┤
mock data ──┘   holds all keys        └─► briefing context ─► server ─► Gemini ─► validate citations ─► UI
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
| `npm test` | 27 tests: ranking, search, AI validation, GitHub mapping, Gemini client, API routes |
| `npm run build` | Type-check and build the web app to `dist/` |
| `npm run build:single` | One self-contained HTML file for the Claude-hosted demo |

Every push and pull request runs the tests and the build (`.github/workflows/ci.yml`).

## Project layout

```
server/
  app.ts            API routes, rate limit, caches; serves dist/ in production
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
  pages/            Dashboard, Feed, ItemDetail, Search
```

## Not built yet

Login and a database (actions are saved in the browser), write-back to GitHub (Assign / Done change WorkRadar only), and the Jira, Slack and email connectors.
