---
name: review-dry
version: 1.0.0
description: Fast read-only DRY review of a diff — returns structured findings
trigger: "review the diff|dry review|is it dry|duplicated"
tools: [read_file, search, exec, project_call]
---

# Review DRY

1. Read the diff. For each new/changed function, `search` the codebase for similar existing logic before assuming it's new.
2. Check the diff itself for internal duplication (two branches/functions that differ by only a parameter).
3. Emit one finding per distinct issue, each with the existing helper/pattern named as the `suggestedFix`. Report each to `retrospective` as you find it (`project_call`, `wait: false`).
4. Return the full findings array as your reply to `implementer`.
