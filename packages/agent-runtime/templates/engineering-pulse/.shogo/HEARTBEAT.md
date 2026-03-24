# Heartbeat Tasks

## Every 30 Minutes

- **PR Triage Refresh** — Run `github-ops` skill: fetch open PRs and issues across all configured repos, update the PR Triage Board canvas, and check for PRs open >2 days without a reviewer. Fire `send_message` alerts if stale PRs are found.
- **Sprint Board Sync** — Check for any new Linear or GitHub issue updates bound to the Sprint Board. Refresh task statuses and recompute velocity KPIs.

## Every Morning (Daily Digest)

- **Developer Activity Digest** — Run `dev-activity-track` skill: fetch the previous 24 hours of commit, PR, and review activity. Update the Developer Activity Feed canvas. Post the daily digest to the configured channel via `send_message`. Compare to the 7-day rolling average and highlight any notable trends (e.g., unusually low commit volume, no PRs merged).
- **PR Aging Check** — Scan all open PRs for age thresholds. Flag any PR that has crossed the 3-day mark without a review and add it to the alert queue.

## Every Week (Weekly Report)

- **Engineering Health Report** — Run `commit-insights` skill: compute weekly commits, median PR cycle time, time to first review, code churn hotspots, and top contributors. Compare all metrics to the previous week (trending up/down). Update the Engineering Health Dashboard and Code Churn surfaces. Post the full report to the configured Slack channel via `send_message`. Save the weekly snapshot to memory under key `engineering_health_weekly_snapshots` for long-term trend analysis.