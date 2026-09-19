---
name: reproduce
version: 1.0.0
description: Mechanically attempt to reproduce a reported bug/regression before handing off to the analyst subagent
trigger: "new issue|reported bug|reproduce|repro steps"
tools: [exec, exec_wait, read_file, search]
---

# Reproduce

Cheap, mechanical, no root-causing — that's `analyst`'s job.

1. Read the report for repro steps, an error message, a stack trace, or a failing scenario.
2. Try the obvious first: run a named test (`exec`), follow literal repro steps, or `search` for the top frame of a stack trace.
3. Capture exact output — command, exit code, stdout/stderr (truncate long output, keep the error).
4. Don't speculate about cause. If you can't reproduce, say exactly what you tried and why it didn't — a documented non-repro is still useful signal for `analyst`.

Return:
```
Reproduction: confirmed | not-confirmed | needs-more-info
Command(s): ...
Output: ...
Notes: ...
```
