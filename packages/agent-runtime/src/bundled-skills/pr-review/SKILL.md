---
name: pr-review
version: 3.0.0
description: Review a specific pull request — fetch diff, analyze code quality, post feedback
trigger: "review pr|review pull request|check pr|code review|review #"
tools: [exec, memory_read, write_file]
---

# PR Review

When asked to review a specific PR, use the pre-installed `gh` CLI via `exec`.
Do not `connect` GitHub or call `GITHUB_*` tools.

1. **Auth** — `exec({ command: "gh auth status" })`. If not authenticated, ask for a PAT, save it to `.env` as `GITHUB_TOKEN`, retry.
2. **Fetch** — Get the PR details:
   - `exec({ command: "gh pr view <number> --json title,body,author,files,reviews,url" })`
   - `exec({ command: "gh pr diff <number>" })`
3. **Analyze** — Review the diff for:
   - Security vulnerabilities (hardcoded secrets, SQL injection, XSS)
   - Logic errors and edge cases
   - Missing error handling
   - Performance concerns
   - Missing tests
4. **Present** — Build a review summary canvas:
   - Overall assessment (approve / request changes)
   - Findings table (severity, file, line, issue, suggestion)
   - Checklist of review criteria
5. **Track** — Log reviewed PR number to memory to avoid re-reviewing

Be constructive, not dismissive. Approve PRs that are good enough — don't block on style nits.
