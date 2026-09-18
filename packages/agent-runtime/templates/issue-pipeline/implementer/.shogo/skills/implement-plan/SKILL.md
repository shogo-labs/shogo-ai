---
name: implement-plan
version: 1.0.0
description: Execute a plan, get it reviewed and gated, and open the PR
trigger: "implement|execute the plan|implementer"
tools: [read_file, write_file, edit_file, exec, exec_wait, search, project_call]
---

# Implement Plan

Follow `AGENTS.md`'s Core Workflow exactly: implement → self-check → fan out to the 3 reviewers → Done Gate → loop (cap 5) or ship.

Practical notes:

- **Diff to send reviewers**: `exec({ command: "git -C <intake-workspace> diff" })` (or `git diff --stat` plus the full diff for the changed files — don't send an entire-repo diff if you've only touched a few files). Include the plan text so reviewers have the same context you do.
- **Test command**: check the repo's own `package.json`/`Makefile`/CI config for the real test command rather than guessing `npm test`.
- **PR body template:**
  ```
  ## Summary
  <plan's Approach, one paragraph>

  ## Changes
  <bullet list, mirrors plan Steps>

  ## Testing
  <regression test name + result, integration tests run>

  ## Review notes
  <one line per finding you addressed, and one line per finding you disputed and why — Done Gate already saw this, this is for the human>

  <!-- shogo:runId=<runId> -->
  ```
- **Iteration cap**: track iteration count in `memory_write({ key: "run:<runId>:iterations", value: n })`. Stop and escalate at 5, don't silently keep going.
