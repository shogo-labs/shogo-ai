---
sidebar_position: 2
title: How Memory Works
slug: /concepts/memory
---

# How Memory Works

Your agent's memory is **persistent Markdown**. Unlike the chat context (which resets each session), memory files survive indefinitely and are loaded at the start of every new session. This is how your agent knows your preferences, remembers past research, and builds context over time.

## The two-layer memory system

Memory is split into two files with different purposes:

```
workspace/
├── MEMORY.md           ← long-term facts, preferences, durable knowledge
└── memory/
    ├── 2026-01-15.md   ← daily log
    ├── 2026-01-16.md   ← daily log
    └── 2026-01-17.md   ← daily log
```

### `MEMORY.md` — long-term facts

This is where durable, important information lives. Think of it as your agent's notebook for things that should always be available.

**What goes here:**
- Your preferences and settings ("preferred Slack channel: #ops-alerts")
- Important context about your systems ("main repo is acme/api on GitHub")
- Ongoing projects and their status
- Key contacts and their roles
- Rules and constraints the agent should always follow

**Example:**

```markdown
# Memory

## User Preferences
- Preferred alert channel: Slack #incidents (urgent), #general (routine)
- Work hours: 9am–6pm PT
- Never send alerts on weekends unless P0

## Systems
- API: https://api.acme.com — primary production endpoint
- Staging: https://staging-api.acme.com
- GitHub: acme/api (main), acme/web (frontend), acme/infra (terraform)

## Ongoing Projects
- [2026-01] Auth refactor — owner: Sarah, deadline: Jan 31
- [2026-01] Database migration — 60% complete, on track

## Key Contacts
- Sarah Chen — backend lead, owns auth + payments
- James Park — DevOps, escalation for infra incidents
```

### `memory/YYYY-MM-DD.md` — daily logs

Daily log files are where the agent records what it did each day. These are written automatically as the agent operates — heartbeat results, research findings, tasks completed.

**Example (`memory/2026-01-15.md`):**

```markdown
# 2026-01-15

## Heartbeat Activity
- 09:00 — All systems healthy. No alerts.
- 11:00 — GitHub: 3 new PRs (acme/api). No critical issues.
- 14:00 — CI failure on acme/api main. Alerted Sarah on Slack. Resolved by 14:22.
- 17:00 — Daily digest sent to #engineering.

## Research
- Researched "LLM observability tools" — found 4 relevant tools (logged in canvas)
- Key finding: OpenTelemetry has native LLM spans in v1.28+

## Tasks Completed
- Updated HEARTBEAT.md to add staging API health check
- Connected GitHub integration for acme/web
```

Daily logs give the agent a history of what happened — useful for writing weekly summaries, tracking recurring issues, or recalling when something changed.

## When memory is read

| File | When loaded |
|------|------------|
| `MEMORY.md` | At the start of every session |
| `memory/YYYY-MM-DD.md` | On demand (when the agent needs daily context) |

The agent searches memory files when it needs to recall something — your preferences, past findings, or previous actions.

## Writing to memory

### Ask the agent to remember something

The most direct way: just tell your agent what to remember.

> "Remember that our main repo is github.com/acme/api and we use GitHub Actions for CI."

> "Note that Sarah is the backend lead and should be alerted for any database issues."

> "Save this research summary to memory."

### The agent writes automatically

During heartbeat runs and research tasks, the agent writes to daily logs automatically — recording what it checked, what it found, and what actions it took.

### Persistent preferences

You can prompt the agent to always store certain kinds of information:

> "Always save research findings to memory so I can reference them later."

> "After every incident, write a summary to memory with what happened and how it was resolved."

## Reading from memory

The agent reads memory automatically when context is relevant. You can also ask it directly:

> "What do you remember about our API architecture?"

> "Look up what you found last week about LLM observability tools."

> "What did you do yesterday during the heartbeat?"

## Memory hygiene

A few practices that keep memory useful over time:

**Be specific about what to remember.** Vague instructions produce vague memory. Instead of "remember our stack," say: "Remember: we use Node.js (API), React (web), PostgreSQL (database), hosted on AWS us-east-1."

**Review and trim periodically.** Ask the agent to review and clean up `MEMORY.md` if it's grown large:

> "Review MEMORY.md and remove anything that's outdated or no longer relevant."

**Separate facts from context.** `MEMORY.md` should contain stable facts. Don't put "we're currently debugging issue #412" in long-term memory — that belongs in a daily log.

**Use memory for recurrence.** If you find yourself repeating the same context ("remember, our staging URL is..."), that's a sign it should be in memory permanently.

## What memory is not

Memory is not the chat context. The chat context is the back-and-forth within a single session — the AI can see previous messages in the current conversation. Memory is persistent storage that survives across sessions.

Memory is also not a database. It's flat Markdown files — great for notes and preferences, not for structured querying of large datasets.

## Related

- [Workspace Files](/concepts/workspace-files) — all workspace files including `MEMORY.md`
- [Using Memory](/guides/using-memory) — practical guide to getting the most from memory
- [Heartbeat](/concepts/heartbeat) — the heartbeat writes to daily logs automatically
