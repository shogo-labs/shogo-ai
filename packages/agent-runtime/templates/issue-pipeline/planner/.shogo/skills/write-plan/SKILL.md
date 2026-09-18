---
name: write-plan
version: 1.0.0
description: Turn a picked analysis option into a concrete implementation plan with regression/integration tests
trigger: "write a plan|plan the fix|planner"
tools: [read_file, search, exec, project_call]
---

# Write Plan

1. **Re-read the picked option** in context of `analyst`'s full options list — understand what was NOT picked and why, so the plan doesn't accidentally reintroduce a rejected approach.
2. **Read the code** the fix touches (mounted read-only from `intake`).
3. **Sequence concrete steps.** Small enough that `implementer` can review its own progress against them; ordered so nothing depends on a later step.
4. **Write the regression test** — the one that fails today and must pass after the fix. Be specific: file path, test name, exact assertion. If a skeleton test file already exists for this area, extend it; don't create a parallel one.
5. **List integration test coverage** and anything from this codebase's conventions the implementer must follow (check `Learned` section above and any project `AGENTS.md`/style docs in the attached repo first).
6. **Hand off:** `project_call({ project: "Issue Pipeline — Implementer", message: "<the full plan>", runId, wait: false })`. Confirm the 202 acceptance; you're done for this run.
