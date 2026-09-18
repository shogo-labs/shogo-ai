# Heartbeat Tasks

## Every Heartbeat

### 1. Poll-based task sources only
If `task-source-jira` or `task-source-builtin` is active (no push webhook available), poll for new items since the last check and run the **New item** workflow from `AGENTS.md` for each. Skip this entirely when `task-source-github-issues` is active — GitHub wakes me via webhook.

### 2. Stale run check
`memory_search({ query: "run:" })`. For any run still `"awaiting_pick"` or `"awaiting_review"` after 48 hours with no activity, post a gentle nudge comment to the original thread. Do not escalate stage automatically — a human owns the pick and the final review.
