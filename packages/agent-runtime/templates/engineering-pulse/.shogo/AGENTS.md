# Engineering Pulse — Agent Strategy

## Canvas Surfaces

Engineering Pulse manages five primary canvas surfaces:

1. **Engineering Health Dashboard** — Top-level KPIs: weekly commits, median PR cycle time, top contributor, active PRs, and CI status. Updated on every heartbeat.
2. **PR Triage Board** — Live table of open pull requests across all tracked repos, sorted by age. Flags PRs with no reviewer after 2+ days. Includes CI status badges and review queue.
3. **Developer Activity Feed** — Per-developer breakdown of commits, PRs opened/merged, and reviews given. Includes a chronological activity feed and daily digest comparison to weekly averages.
4. **Sprint Board** — Kanban-style board with To Do / In Progress / Done columns, burndown chart, and velocity KPIs. Supports task CRUD via mutation buttons.
5. **Code Churn & Insights** — Hotspot table of frequently changed files, PR aging analysis, and weekly engineering health report with week-over-week trend comparisons.

## Core Workflow

1. **On activation**, check for GitHub integration via `tool_search`. If not installed, prompt the user to connect via `tool_install({ name: "github" })`.
2. **Read configuration** from memory keys `git_insights_config` and `dev_activity_repos`. If missing, ask the user which repos and team members to track.
3. **Fetch data** from GitHub: commits, pull requests, reviews, and issues across all configured repos.
4. **Compute metrics**: weekly commits, PR cycle time, time to first review, code churn, PR aging, and contributor rankings.
5. **Build or update canvases** for all five surfaces using the latest data.
6. **Evaluate alerts**: flag PRs open >2 days without a reviewer and send alerts to the configured channel via `send_message`.
7. **Persist snapshots** to memory for trend analysis and week-over-week comparisons.
8. **On weekly heartbeat**, compile the full engineering health report and post it to the configured Slack or Teams channel.

## Skill Workflow

- **commit-insights**: Runs on weekly heartbeat. Fetches all commits and PRs for the analysis window, computes health metrics, updates the Engineering Health Dashboard and Code Churn surface, and posts the weekly report.
- **github-ops**: Runs on every heartbeat. Fetches open PRs and issues, updates the PR Triage Board, and fires alerts for stale PRs.
- **dev-activity-track**: Runs on daily morning heartbeat. Fetches 24h activity, updates the Developer Activity Feed, posts the daily digest, and saves snapshots.
- **sprint-board**: Runs on user interaction and heartbeat. Manages the Sprint Board canvas, handles task CRUD via mutation buttons, and logs sprint progress for velocity calculations.

## Recommended Integrations

Use `tool_search` to find and install these integrations:

- **github** — Core integration. Required for all commit, PR, issue, and review data.
- **slack** — Post daily digests, weekly reports, and PR stale alerts to engineering channels.
- **linear** — Optional. Bind sprint tasks directly from Linear for live sprint board data.
- **jira** — Alternative to Linear for sprint and issue tracking.
- **pagerduty** — Optional. Correlate incident activity with commit and deploy patterns.

## Canvas Patterns

- **Metric Grid** — Use for top-level KPIs on the Engineering Health Dashboard (commits, cycle time, active PRs, CI status).
- **DataList / Table** — Use for PR Triage Board, Developer Activity Feed, and Code Churn hotspots. Include sortable columns for age, author, and status.
- **Kanban Grid with Cards** — Use for Sprint Board. Cards show title, priority Badge, assignee, and story points. Status transitions via mutation buttons.
- **Line Chart (Burndown)** — Use on Sprint Board for points remaining over sprint duration.
- **Tabs** — Use on the Engineering Health Dashboard to switch between weekly summary, PR details, and contributor breakdown without leaving the surface.
- **Badge** — Use for priority labels (High/Medium/Low) and PR status (Open/Reviewed/Merged/Stale).