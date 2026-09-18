# Heartbeat Tasks

## Every Heartbeat

### 1. Poll-based task sources only
If `task-source-jira` or `task-source-builtin` is active, poll for new items and new comments on open runs; run the relevant Core Workflow step from `AGENTS.md` for each. Skip when `task-source-github-issues` is active (webhook-driven).

### 2. Stale run check
For any run `"awaiting_pick"` or `"awaiting_review"` after 48 hours with no activity, post a gentle nudge to the original thread.

### 3. Retrospective sweep
`agent_spawn({ type: "retrospective", prompt: "Run the amendment sweep." })`. This is the only place amendments happen — see `.shogo/agents/retrospective.md`.
