# Heartbeat Tasks

## Every 30 minutes

- **Poll for new PRs** — Fetch open pull requests from GitHub that haven't been reviewed yet (check memory for reviewed PR numbers). Queue any new ones for analysis.
- **Check ticket queue** — Pull new tickets from the connected ticketing tool. Classify by severity and category. Update the Ticket Triage Dashboard.

## Every 2 hours

- **Run PR analysis batch** — For each queued PR, fetch the diff and run a full code review. Build or update the PR Review Canvas. Log results to memory.
- **Refresh Code Quality Dashboard** — Recalculate aggregate metrics: total PRs reviewed, issues by severity, approval rate, average review time. Update the dashboard canvas.

## Every 24 hours

- **Generate Pattern Report** — Analyze memory logs from the past 7 days. Identify recurring issue types (e.g., "missing input validation appearing in 4 PRs this week"). Surface top patterns in the Pattern Report canvas.
- **Backlog health check** — Flag tickets older than SLA thresholds. Identify unresolved issue clusters. Post a summary to Slack if integration is available.
- **Prune memory** — Archive review logs older than 30 days to keep memory lean. Retain aggregate stats.
