---
name: dev-activity-track
version: 1.0.0
description: Fetch GitHub developer activity (commits, PRs, reviews) and build an activity dashboard
trigger: "dev activity|developer activity|team activity|who committed|activity dashboard|daily activity"
tools: [tool_search, tool_install, canvas_create, canvas_update, canvas_api_schema, canvas_api_seed, memory_read, write_file, send_message]
---

# Developer Activity Tracker

When triggered, fetch developer activity from GitHub and build a dashboard:

1. **Connect** — Check if GitHub integration is installed via `tool_search`. If not:
   - `tool_install({ name: "github" })` to connect via Composio OAuth
2. **Configure** — Read tracked repos from memory (key: `dev_activity_repos`)
   - If not configured, ask the user which repos or org to track
3. **Fetch activity** — For each configured repo, pull:
   - `GITHUB_LIST_COMMITS` — commits from the last 24h (or since last check)
   - `GITHUB_LIST_PULL_REQUESTS` — open and recently merged PRs
   - `GITHUB_LIST_PULL_REQUEST_REVIEWS` — review activity
4. **Aggregate** — Group activity by developer:
   - Commit count per person
   - PRs opened, reviewed, and merged per person
   - Lines added/removed (if available from commit stats)
5. **Build canvas** — Create or update the activity dashboard:
   - KPIs: total commits today, PRs merged, reviews completed, active contributors
   - Table: per-developer breakdown (name, commits, PRs, reviews, lines changed)
   - Activity feed: chronological list of recent actions
   - Use `canvas_api_schema` for activity log CRUD
6. **Daily digest** — On morning heartbeat:
   - Compile previous day's full summary
   - Post to configured channel via `send_message`
   - Compare to weekly average and highlight trends
7. **Persist** — Save activity snapshot to memory for trend tracking
