---
name: review-security
version: 1.0.0
description: Fast read-only security review of a diff — returns structured findings
trigger: "review the diff|security review|is it secure"
tools: [read_file, search, exec, project_call]
---

# Review Security

1. Read the diff. For each changed file, check it against the categories in `AGENTS.md`'s "What I Look For".
2. When something looks off, read enough surrounding code (`read_file`/`search`, read-only mount from `intake`) to confirm it's real, not a false alarm from seeing the diff out of context.
3. Emit one finding per distinct issue (don't bundle unrelated problems into one finding — `retrospective` groups by `category`, and bundling breaks that).
4. Report each finding to `retrospective` as you find it (`project_call`, `wait: false`) — don't batch until the end.
5. Return the full findings array as your reply to `implementer`.
