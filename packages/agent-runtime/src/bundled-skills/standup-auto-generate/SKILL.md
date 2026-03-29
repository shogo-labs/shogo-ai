---
name: standup-auto-generate
version: 1.0.0
description: Auto-generate daily standup summaries from GitHub commits, PRs, and Slack activity
trigger: "generate standup|auto standup|standup summary|what did the team do|morning summary|daily summary"
tools: [tool_search, tool_install, canvas_create, canvas_update, memory_read, write_file, send_message]
---

# Automatic Standup Generator

Auto-generate standup summaries from development activity:

1. **Connect** — Ensure GitHub and Slack are connected:
   - `tool_install({ name: "github" })` if not connected
   - `tool_install({ name: "slack" })` if not connected (optional but recommended)
2. **Gather data** — Pull last 24h of activity:
   - GitHub: commits, PRs opened/merged/reviewed, issues closed per developer
   - Slack (if connected): messages in engineering channels for context
3. **Classify** — For each team member, categorize activity into:
   - **Done:** merged PRs, closed issues, significant commits
   - **In Progress:** open PRs, branches with recent commits
   - **Blockers:** PRs with requested changes, stale PRs (>2 days no review), failing CI
4. **Generate summary** — Build structured standup:
   ```
   **Daily Standup — {date}**

   **{Developer Name}**
   Done: Merged PR #123 (feature X), closed issue #456
   In Progress: PR #789 (refactor Y) — awaiting review
   Blockers: None

   **{Developer Name 2}**
   ...
   ```
5. **Build canvas** — Update standup dashboard:
   - Today's summary with per-person sections
   - KPIs: team members active, PRs in flight, commits yesterday
   - Blockers section highlighted at top
6. **Deliver** — Post compiled summary to configured Slack channel
7. **Archive** — Save to memory for historical reference and pattern detection
   - Track recurring blockers across standups
   - Flag developers with no activity (may be on PTO or blocked)
