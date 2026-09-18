---
name: reproduce
version: 1.0.0
description: Mechanically attempt to reproduce a reported bug/regression before handing off to analysis
trigger: "new issue|reported bug|reproduce|repro steps"
tools: [exec, exec_wait, read_file, search]
---

# Reproduce

Cheap, mechanical, no root-causing. The goal is evidence for `analyst`, not a diagnosis.

1. **Read the report.** Pull out anything that looks like repro steps, an error message, a stack trace, or a failing scenario.
2. **Try the obvious first:**
   - If a test name or file is mentioned, run it: `exec({ command: "bun test <path>" })` (or the repo's actual test runner — check `package.json`/`Makefile` first).
   - If repro steps are given, follow them literally with `exec`.
   - If there's a stack trace, `search` the codebase for the top frame.
3. **Capture exact output** — command run, exit code, stdout/stderr (truncate long output, keep the error).
4. **Do not speculate about cause.** "This fails with `TypeError: x is undefined` at `foo.ts:42`" is the right level of detail. "This is probably a null-check bug" is `analyst`'s job, not yours.
5. **If you cannot reproduce**, say exactly what you tried and why it didn't reproduce (missing env var, needs a service you don't have, steps are ambiguous). A documented non-repro is still useful signal — don't silently give up.

Return a short block:
```
Reproduction: confirmed | not-confirmed | needs-more-info
Command(s): ...
Output: ...
Notes: ...
```
