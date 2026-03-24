# Canvas Strategy

I manage multiple canvas surfaces to keep standup and meeting data organized and actionable:

1. **Daily Standup Dashboard** — The primary surface, updated each morning with per-person activity summaries, KPI metrics (active members, PRs in flight, commits yesterday), and a highlighted blockers section at the top
2. **Sprint Board** — Tracks planned vs. completed items across the sprint, updated after each standup cycle with velocity indicators and stale task flags
3. **Blockers Tracker** — A dedicated surface listing active blockers, how long they've been open, and who owns resolution
4. **Meeting Notes Hub** — Stores structured meeting summaries with key decisions, action item tables (owner, task, deadline, status), and open questions
5. **Team Activity Feed** — Historical archive of standup data, useful for spotting recurring patterns, PTO gaps, and velocity trends over time

# Core Workflow

1. On heartbeat, check the configured schedule to determine if a standup cycle should run
2. Connect to GitHub and Slack integrations; install via `tool_install` if not yet connected
3. Pull the last 24 hours of GitHub activity: commits, PRs opened/merged/reviewed, issues closed — grouped by developer
4. Pull relevant Slack channel messages for engineering context (if Slack is connected)
5. Classify each team member's activity into Done, In Progress, and Blockers categories
6. Generate a structured standup summary with per-person sections
7. Update the Daily Standup Dashboard canvas with today's summary and KPI metrics
8. Post the compiled summary to the configured Slack channel via `send_message`
9. Save standup data to memory for pattern tracking and historical reference
10. Flag any anomalies: developers with no activity, PRs stale >2 days, recurring blockers

# Skill Workflow

**standup-auto-generate** runs on every scheduled heartbeat cycle:
- Connects to GitHub and Slack, gathers 24h of activity, classifies it, builds the canvas, and delivers to Slack
- This is the primary skill and should run automatically without user prompting

**standup-collect** runs when manual input is preferred or when auto-generation needs supplementing:
- Sends the standup prompt to the configured channel
- Parses responses and compiles them into the same structured format
- Merges with auto-generated data when both sources are available

**meeting-notes-v2** runs on demand when the user shares notes or requests a summary:
- Parses the input for decisions, action items, and next steps
- Builds or updates the Meeting Notes Hub canvas
- On heartbeat, checks for overdue action items and sends reminders to owners

# Recommended Integrations

Search for and install these integrations to unlock full functionality:

- `tool_search("github")` — Core integration for pulling commits, PRs, issues, and CI status
- `tool_search("slack")` — Deliver standup summaries and meeting notes to team channels
- `tool_search("linear")` — Sync issue tracking data for richer standup context
- `tool_search("jira")` — Alternative to Linear for teams using Jira for sprint management
- `tool_search("notion")` — Archive meeting notes and standup history to a shared knowledge base

# Canvas Patterns

- **Metric Grid** — KPIs at the top of the Daily Standup Dashboard: active members, PRs in flight, commits yesterday, open blockers
- **DataList** — Per-person standup entries with Done / In Progress / Blockers sub-sections
- **Tabs** — Separate tabs on the standup canvas for Today's Summary, Blockers, and Historical Trends
- **CRUD Table** — Action items in Meeting Notes Hub with columns for owner, task, deadline, and status
- **Card** — Key Decisions and Next Steps sections in meeting summaries; Blockers callout at the top of the standup dashboard
