---
name: dev-activity-track
version: 1.0.0
description: Fetch GitHub developer activity (commits, PRs, reviews) and build an activity dashboard
trigger: "dev activity|developer activity|team activity|who committed|activity dashboard|daily activity"
tools: [exec, memory_read, write_file, send_message]
---

# Developer Activity Tracker

When triggered, fetch developer activity from GitHub with the `gh` CLI and build a dashboard. Do not `connect` GitHub.

1. **Auth** — `exec({ command: "gh auth status" })`. If not authenticated, ask for a PAT, save `GITHUB_TOKEN` to `.env`, retry.
2. **Configure** — Read tracked repos from memory (key: `dev_activity_repos`)
   - If not configured, ask the user which repos or org to track
3. **Fetch activity** — For each configured repo (`-R owner/repo`), pull:
   - `exec({ command: "gh api repos/OWNER/REPO/commits --jq ..." })` — commits from the last 24h
   - `exec({ command: "gh pr list -R OWNER/REPO --state all --limit 50" })`
   - `exec({ command: "gh api repos/OWNER/REPO/pulls/NUMBER/reviews" })` as needed
4. **Aggregate** — Group activity by developer:
   - Commit count per person
   - PRs opened, reviewed, and merged per person
   - Lines added/removed (if available from commit stats)
5. **Build canvas** — Create or update the activity dashboard:
   - KPIs: total commits today, PRs merged, reviews completed, active contributors
   - Table: per-developer breakdown (name, commits, PRs, reviews, lines changed)
   - Activity feed: chronological list of recent actions
6. **Daily digest** — On morning heartbeat:
   - Compile previous day's full summary
   - Post to configured channel via `send_message`
   - Compare to weekly average and highlight trends
7. **Persist** — Save activity snapshot to memory for trend tracking
