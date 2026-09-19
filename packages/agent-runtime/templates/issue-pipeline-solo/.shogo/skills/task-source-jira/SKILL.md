---
name: task-source-jira
version: 1.0.0
description: TaskSource adapter backed by Jira via Composio
trigger: "jira|jira ticket|jira comment"
tools: [search_integrations, connect]
---

# Task Source — Jira

Active when a Jira integration is connected via Composio. No push webhook — `HEARTBEAT.md`'s poll step drives item detection.

## `list()` — poll for new/updated items
Use the installed Jira search action (check exact names with `search_integrations({ query: "jira issue" })`) with a JQL filter like `project = <KEY> AND updated >= -1h`. Track the last-polled timestamp in `memory_write({ key: "jira:lastPoll", value: <ISO time> })`.

## `get(ref)`
`JIRA_GET_ISSUE` with the issue key.

## `comment(ref, body, runId)`
`JIRA_ADD_COMMENT`, with the runId marker appended on its own quoted line: `\n\n{quote}shogo:runId=<runId>{quote}`.

## `transition(ref, status)`
`JIRA_TRANSITION_ISSUE` — optional.

## Detecting a human's reply
No webhook — the heartbeat poll checks for new comments on issues with an open run too, recovering `runId` from the quoted marker line, then routes per `AGENTS.md`'s "Reply on an existing run" workflow.
