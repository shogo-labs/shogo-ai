---
name: task-source-github-issues
version: 1.0.0
description: TaskSource adapter backed by the connected GitHub repo — issues, comments, and PR reviews
trigger: "github issue|post comment|pr review|task source"
tools: [exec, exec_wait, web]
---

# Task Source — GitHub Issues

Active when this project has a GitHub App connection. `apps/api/src/routes/github.ts` forwards `issues`, `issue_comment`, `pull_request_review`, and `pull_request_review_comment` webhooks straight to this project's agent as a rendered message — you never fetch the event yourself.

## `comment(ref, body, runId)`
```bash
gh issue comment <number> --repo <owner/repo> --body "$(cat <<'EOF'
<body>

<!-- shogo:runId=<runId> -->
EOF
)"
```
Use `gh pr comment` for a PR. The HTML comment is invisible on GitHub — don't strip it.

## `list()` / `get(ref)`
`gh issue view <number> --repo <owner/repo> --json title,body,url,comments,state` (or `gh pr view`).

## `transition(ref, label)`
`gh issue edit <number> --repo <owner/repo> --add-label "<label>"` — optional.

## Recovering a `runId`
Already recovered by the API before you're woken, when one exists. If a message lacks one and should have it, `gh issue view`/`gh pr view` and look for the marker in the body.
