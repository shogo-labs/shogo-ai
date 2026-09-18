---
name: analyse-root-cause
version: 1.0.0
description: Diagnose root cause and draft 5 solution options for an incoming issue
trigger: "analyse|root cause|five options|analyst"
tools: [read_file, search, exec, memory_read]
---

# Analyse Root Cause

1. **Read the report and repro notes.** Note anything already confirmed by `intake` — you don't need to re-run the repro, just use its output.
2. **Locate the code.** `search` the repo (mounted read-only from `intake`) for the failing behavior — error strings, function names, the feature area named in the report.
3. **Verify, don't guess.** Read enough of the surrounding code to actually confirm the mechanism. If you can `exec` a quick check (read a config value, trace a call path) to firm up your theory, do it.
4. **Draft 5 options** spanning the real spectrum: minimal/targeted, root-cause/thorough, and at least one alternative approach in between. Each needs effort and risk, and a one-line "why".
5. **Pick a recommendation**, labeled clearly as a recommendation — the human makes the call, not you.
6. Return the exact reply shape from `AGENTS.md` (`## Root Cause` / `## Options` / `## Recommendation`).
