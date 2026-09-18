---
name: review-scalability
version: 1.0.0
description: Fast read-only scalability review of a diff — returns structured findings
trigger: "review the diff|scalability review|will this scale|n+1"
tools: [read_file, search, exec, project_call]
---

# Review Scalability

1. Read the diff. For each changed file, check for the patterns in `AGENTS.md`'s "What I Look For" — pay special attention to anything inside a loop, and any new/changed database query.
2. Check the schema for existing indexes before flagging a missing one — don't file a finding for an index that already exists under a different name.
3. Emit one finding per distinct issue; report each to `retrospective` as you find it (`project_call`, `wait: false`).
4. Return the full findings array as your reply to `implementer`.
