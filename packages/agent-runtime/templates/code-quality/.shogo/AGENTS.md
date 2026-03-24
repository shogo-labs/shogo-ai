# Agent Strategy

## Canvas Surfaces

1. **PR Review Canvas** — Per-PR analysis with overall verdict, findings table, and review checklist
2. **Code Quality Dashboard** — Aggregate metrics: PRs reviewed, issues found by severity, approval rate, avg review turnaround
3. **Ticket Triage Dashboard** — Open tickets, volume trends, priority breakdown, and CRUD table of active tickets
4. **Pattern Report** — Recurring issues across PRs and tickets grouped by category (security, performance, testing gaps)
5. **Backlog Health** — Ticket aging, SLA compliance, and unresolved issue clusters

## Core Workflow

1. On activation, check memory for previously reviewed PRs and triaged tickets
2. Search for installed integrations via `tool_search("github")` and `tool_search("zendesk")` or `tool_search("linear")`
3. Install missing integrations via `tool_install` with Composio OAuth
4. Pull open PRs and recent tickets from connected tools
5. Triage tickets by severity and category; update the Ticket Triage Dashboard
6. Queue unreviewed PRs for analysis
7. For each PR: fetch metadata and diff, run analysis, build PR Review Canvas, log to memory
8. Update the Code Quality Dashboard with aggregate metrics
9. Surface pattern insights in the Pattern Report canvas

## Skill Workflow

### `pr-review`
- Triggered on demand ("review PR #123") or on heartbeat for open PRs
- Uses `GITHUB_GET_PULL_REQUEST` + `GITHUB_LIST_PULL_REQUEST_FILES`
- Analyzes diff for: security vulnerabilities, logic errors, missing error handling, performance, test coverage
- Outputs a PR Review Canvas with verdict, findings DataList, and criteria checklist
- Logs reviewed PR number to memory to prevent duplicate reviews

### `ticket-triage`
- Runs on heartbeat to pull and classify new tickets
- Connects to Zendesk, Linear, or similar via `tool_search` → `tool_install`
- Classifies by severity (P0–P3) and category (auth, billing, performance, bug, feature)
- Updates Ticket Triage Dashboard with KPIs, volume chart, priority breakdown, and ticket table
- Logs triage summary to memory for pattern tracking

## Recommended Integrations

- `tool_search("github")` — PR data, file diffs, review comments
- `tool_search("linear")` — Issue tracking and ticket triage
- `tool_search("zendesk")` — Support ticket management
- `tool_search("slack")` — Post review summaries and alerts to engineering channels
- `tool_search("jira")` — Link PRs to sprint tickets and track issue resolution

## Canvas Patterns

- **Metric Grid** — KPIs: PRs reviewed, issues found, approval rate, avg turnaround, open tickets
- **DataList with severity badges** — Findings table: severity, file, line, issue description, suggestion
- **Bar Chart** — Ticket volume by day; issues found by category over time
- **Horizontal Bar Chart** — Priority breakdown (P0/P1/P2/P3 distribution)
- **Checklist component** — PR review criteria (security scan, error handling, tests, docs)
- **Tabs** — Separate views for PR Reviews, Ticket Triage, and Pattern Reports
- **CRUD Table** — Active tickets with subject, priority, status, assignee, created date
