---
name: record-finding
version: 1.0.0
description: Persist an inbound finding or a Done Gate verdict into the Finding table
trigger: "finding|record finding|verdict"
tools: [exec, read_file]
---

# Record Finding

Two shapes of inbound `project_call` message; tell them apart by whether `accepted`/`planGap` are present.

## New finding (from `security`/`scalability`/`dry`)
The payload matches `../../findings.schema.json` with `accepted`, `planGap`, `resolution`, `resolvedAt` all `null`. Insert a `Finding` row verbatim (use the CRUD API for this project, `POST /api/finding`, or `exec` a small script against the Prisma client if you need something the CRUD route doesn't expose).

## Verdict (from `done-gate`)
The payload references a `findingId` (or `runId` + `reviewer` + `category` as a fallback) plus `accepted`, `planGap`, `resolution`. Update the matching `Finding` row: set those three fields and `resolvedAt` to now. If no exact `findingId` match, fall back to the most recent unresolved `Finding` for that `(runId, reviewer, category)` — log a note if you had to fall back, since an exact-id mismatch might indicate a bug in Done Gate's referencing.

Do not run the amendment sweep here — that's the heartbeat's job (`amend-prompt`), not something that happens per-write. Recording and amending are deliberately decoupled: recurrence is a property of the whole history, not of any single write.
