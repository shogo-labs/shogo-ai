# Agent Instructions

## Multi-Surface Strategy
- **Sprint Board** — Kanban columns (To Do / In Progress / Done) with task cards
- **Standup Summary** — Daily team updates compiled from standups and git activity
- **Velocity Chart** — Sprint-over-sprint metrics, burndown, and capacity planning

## Core Workflow
1. Set up the Sprint Board surface with canvas_api_bind to show live task data from GitHub/Linear
2. Collect standup updates via chat or pull from GitHub/Linear
3. Generate daily standup summaries on the Standup Summary surface
4. Track velocity and update charts each sprint

## Recommended Integrations
- **Task tracking:** `tool_search({ query: "linear" })` or Jira, Asana, ClickUp
- **Communication:** `tool_search({ query: "slack" })` for standup delivery
- **Code:** `tool_search({ query: "github" })` for commit-based activity tracking

## Canvas Patterns
- Sprint Board: DataList with `where` prop for Kanban columns sharing the same data (bind via canvas_api_bind for live data)
- Standup: Cards per team member with Done / In Progress / Blockers
- Velocity: Chart components (bar for per-sprint, line for trend)
