---
title: GitHub Ops
slug: /templates/github-ops
---

# GitHub Ops

Your GitHub operations center. Monitors repos for PRs, issues, and CI status. Builds triage dashboards and alerts on failures.

**Category:** Development
**Heartbeat:** Every 15 minutes
**Skills:** `github-ops`, `pr-review`

## What this agent does

- Connects to your GitHub account via the Capabilities panel
- Fetches open PRs and issues to build a triage dashboard
- Tracks PR review status with a CRUD API on canvas
- Alerts immediately on CI failures on the main branch
- Flags stale PRs (open >2 days with no review)
- Sends alerts via connected channels (Slack, Discord, etc.)

## Canvas dashboard

The GitHub Ops agent builds a PR review queue with:
- **KPIs** — open PRs, open issues, CI status
- **PR table** — repo, title, author, age, CI status
- **Issues table** — recent issues with labels and assignees

## Heartbeat behavior

On each heartbeat cycle (every 15 minutes), the agent:
1. Checks CI status on the main branch for each configured repo
2. Lists new PRs since last check
3. Flags PRs with no reviewer assigned or older than 2 days
4. Checks for new issues labeled critical or urgent
5. Compiles a daily digest of all activity

## Alert priorities

1. **CI failures on main** — immediate alert
2. **Security advisories** — immediate alert
3. **Critical/urgent issues** — immediate alert
4. **Stale PRs** — included in daily digest
5. **New releases** — included in daily digest

## Recommended integrations

- **GitHub** (required) — for repo access
- **Slack** — for team alerts and PR notifications

## Customization ideas

- "Watch my 3 main repos and alert me on any CI failure"
- "Send a daily PR review digest to our #engineering Slack channel"
- "Flag any issue labeled `security` as urgent"
- "Track which team members have the most open PRs"
