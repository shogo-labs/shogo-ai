---
name: task-source-builtin
version: 1.0.0
description: TaskSource adapter backed by this project's own database — used when no external tracker is connected
trigger: "no tracker connected|builtin tracker|create ticket"
tools: [exec, read_file, write_file]
---

# Task Source — Built-in

Active when neither GitHub nor Jira is connected. Items live in this project's own `TrackerItem`/`TrackerComment` models (see `prisma/schema.prisma`). Humans create items directly via chat, or point you at a spec doc to ingest.

## `list()` / `get(ref)`
Query `TrackerItem` via the generated CRUD API (`GET /api/tracker-item`, `GET /api/tracker-item/:id`).

## `comment(ref, body, runId)`
Create a `TrackerComment` row with `runId` stored in its own column.

## `transition(ref, status)`
Update `TrackerItem.status` (`open`, `analyzing`, `planning`, `implementing`, `in_review`, `done`).

## Human reply
No external webhook — a human's pick or PR-style feedback arrives as a chat message to you, or a new `TrackerComment` row. Resolve the `runId` from context and follow `AGENTS.md`'s "Reply on an existing run" workflow.
