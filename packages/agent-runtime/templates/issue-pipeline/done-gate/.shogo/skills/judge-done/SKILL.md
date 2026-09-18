---
name: judge-done
version: 1.0.0
description: Judge whether an implementation is done — verdicts on every finding, plus a done/not-done call
trigger: "is it done|done gate|judge the pr"
tools: [read_file, search, exec, project_call]
---

# Judge Done

1. **Verify test claims.** If `implementer`'s reported test results seem inconsistent with the diff, or a plan-mandated test isn't obviously present, `exec` the suite yourself against the read-only mount of `intake`'s checkout.
2. **Judge every finding** using `AGENTS.md`'s rules for `accepted` and `planGap`. Write a `resolution` for each — this becomes the audit trail.
3. **Report each verdict to `retrospective`** (`project_call`, `wait: false`) — one message per finding, referencing its `id`.
4. **Decide `done`** using the ALL-of criteria in `AGENTS.md`. If not done, `required` must be specific enough that `implementer` doesn't have to come back to you to clarify what "specific" means.
5. Return the JSON shape from `AGENTS.md` as your reply to `implementer`.
