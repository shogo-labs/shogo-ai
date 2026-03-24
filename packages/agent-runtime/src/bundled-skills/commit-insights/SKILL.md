---
name: commit-insights
version: 1.0.0
description: Analyze git commit patterns, PR cycle times, code churn, and team velocity for engineering managers
trigger: "commit insights|engineering metrics|team velocity|pr cycle time|code churn|engineering health|team stats"
tools: [tool_search, tool_install, canvas_create, canvas_update, canvas_api_schema, canvas_api_seed, memory_read, memory_write, send_message, web]
---

# Commit Insights

Analyze git activity and produce engineering health metrics:

1. **Connect** — Check if GitHub integration is installed via `tool_search`. If not:
   - `tool_install({ name: "github" })` to connect via Composio OAuth
2. **Configure** — Read tracked repos and team from memory (key: `git_insights_config`)
   - Repos to analyze, team member GitHub usernames
   - If not configured, ask the user which repos/team to track
3. **Fetch data** — For each configured repo:
   - `GITHUB_LIST_COMMITS` — all commits in the analysis window (7 days default)
   - `GITHUB_LIST_PULL_REQUESTS` — open, merged, and closed PRs
   - PR details: time from open to first review, time to merge, review rounds
4. **Compute metrics** —
   - **Weekly commits:** total and per-developer breakdown
   - **PR cycle time:** median time from PR open to merge
   - **Time to first review:** median time from PR open to first review comment
   - **Code churn:** files changed frequently (>3 times in a week)
   - **PR aging:** open PRs sorted by age, flagging those >3 days without review
   - **Top contributors:** ranked by commits + reviews
5. **Build canvas** — Create or update the insights dashboard:
   - KPIs: weekly commits, avg PR cycle time, top contributor, active PRs
   - Team leaderboard table (developer, commits, PRs merged, reviews given)
   - PR aging table (PR title, author, age, status, reviewers)
   - Code churn hotspots (files changed most frequently)
6. **Weekly report** — On weekly heartbeat:
   - Compile full engineering health report
   - Compare to previous week (trending up/down)
   - Post to configured channel via `send_message`
7. **Persist** — Save weekly snapshots to memory for trend analysis
