---
name: task-source-jira
version: 1.0.0
description: TaskSource adapter backed by Jira via Composio
trigger: "jira|jira ticket|jira comment"
tools: [search_integrations, connect]
---

# Task Source — Jira

Active when a Jira integration is connected via Composio (`search_integrations({ query: "jira" })` then `connect({ name: "jira" })` if not already installed). No push webhook is available for Jira in this setup, so `HEARTBEAT.md`'s poll step drives item detection instead of a wake.

Implements the same `TaskSource` shape as the GitHub adapter — everything downstream of `intake` is adapter-agnostic and never calls Jira actions directly.

## `list()` — poll for new/updated items
Use the installed Jira search action (e.g. `JIRA_SEARCH_ISSUES` / `JIRA_JQL_SEARCH` — check exact action names with `search_integrations({ query: "jira issue" })` since Composio action names vary by connector version) with a JQL filter like `project = <KEY> AND updated >= -1h`. Track the last-polled timestamp in `memory_write({ key: "jira:lastPoll", value: <ISO time> })` so you don't reprocess the same items every heartbeat.

## `get(ref)`
`JIRA_GET_ISSUE` (or equivalent) with the issue key.

## `comment(ref, body, runId)`
`JIRA_ADD_COMMENT` with the issue key and `body`. Append the marker on its own line at the end of the comment body: `\n\n{quote}shogo:runId=<runId>{quote}` (Jira doesn't render HTML comments; a quoted line that's easy to regex out of a plain-text comment body works the same way). When polling for replies, look for that line to recover the `runId` for a given comment.

## `transition(ref, status)`
`JIRA_TRANSITION_ISSUE` (workflow transition, e.g. to "In Progress" / "Done") — optional, skip if the project's workflow doesn't have matching states.

## Detecting a human's reply (pick, or PR feedback)
Since there's no webhook, the heartbeat poll from `HEARTBEAT.md` is what discovers new comments too — when polling `list()`, also check for new comments on issues with an open run (`memory_search({ query: "run:" })`) and recover the `runId` from the quoted marker line to route the reply per `AGENTS.md`'s "Reply on an existing run" workflow.
