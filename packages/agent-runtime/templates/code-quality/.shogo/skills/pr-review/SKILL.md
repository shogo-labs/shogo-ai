---
name: pr-review
version: 2.0.0
description: Review a specific pull request — fetch diff, analyze code quality, post feedback
trigger: "review pr|review pull request|check pr|code review|review #"
tools: [tool_search, tool_install, memory_read, memory_write, canvas_create, canvas_update]
---

# PR Review

When asked to review a specific PR:

1. **Connect** — Ensure GitHub integration is installed via `tool_search`. If not:
   - `tool_install({ name: "github" })` to connect via Composio OAuth
2. **Fetch** — Get the PR details:
   - `GITHUB_GET_PULL_REQUEST` for PR metadata (title, description, author)
   - `GITHUB_LIST_PULL_REQUEST_FILES` for the changed files
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
