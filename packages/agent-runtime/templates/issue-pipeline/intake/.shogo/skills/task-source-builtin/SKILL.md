---
name: task-source-builtin
version: 1.0.0
description: TaskSource adapter backed by this project's own database — used when no external tracker is connected
trigger: "no tracker connected|builtin tracker|create ticket"
tools: [exec, read_file, write_file]
---

# Task Source — Built-in

Active when neither GitHub nor Jira is connected. Items live in this project's own `TrackerItem` model (see `prisma/schema.prisma`) so the pipeline works standalone — connecting a real tracker later is a config change, not a data migration (the shape is intentionally close to the Jira/GitHub adapters: `ref`, `title`, `body`, `comments[]`).

Humans create items directly (chat with me: "there's a bug where X" → I create a `TrackerItem` row) or point me at a spec doc to ingest. There's no webhook to wait for; `HEARTBEAT.md`'s poll step and direct chat both drive the workflow.

## `list()` / `get(ref)`
Query `TrackerItem` via the generated CRUD API for this project (`GET /api/tracker-item`, `GET /api/tracker-item/:id`) or `exec` a small script against the Prisma client if you need a filter the CRUD routes don't expose.

## `comment(ref, body, runId)`
Create a `TrackerComment` row linked to the `TrackerItem`, with `runId` stored in its own column (no marker-parsing needed — this is the one adapter where you own the schema, so store `runId` as data, not text).

## `transition(ref, status)`
Update `TrackerItem.status` (`open`, `analyzing`, `planning`, `implementing`, `in_review`, `done`).

## Human reply
Since there's no external webhook, a human's "pick" or PR-style feedback arrives as a normal chat message to me, or a new `TrackerComment` a human writes directly. Either way, resolve the `runId` from context (chat: ask which run if ambiguous; comment: read the column) and follow `AGENTS.md`'s "Reply on an existing run" workflow.
