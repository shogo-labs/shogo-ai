---
name: task-source-github-issues
version: 1.0.0
description: TaskSource adapter backed by the connected GitHub repo — issues, comments, and PR reviews
trigger: "github issue|post comment|pr review|task source"
tools: [exec, exec_wait, web]
---

# Task Source — GitHub Issues

Active when this project has a GitHub App connection (repo sync configured). Implements the `TaskSource` shape (`list`, `get`, `comment`, `transition`) against `gh`, so every other skill can call it without knowing GitHub specifics.

Every event arrives as a wake, not a poll — `apps/api/src/routes/github.ts` forwards `issues`, `issue_comment`, `pull_request_review`, and `pull_request_review_comment` webhooks straight to this project's agent as a rendered message. You never need to fetch the event yourself; by the time you're running, the message already contains the issue/comment/review body and URL.

## `comment(ref, body, runId)`
Post a comment on an issue or PR with the run's `runId` embedded so a later reply can be traced back:
```bash
gh issue comment <number> --repo <owner/repo> --body "$(cat <<'EOF'
<body>

<!-- shogo:runId=<runId> -->
EOF
)"
```
Use `gh pr comment` instead when `ref` is a PR. The HTML comment is invisible when GitHub renders the comment — don't strip it when composing.

## `list()` / `get(ref)`
`gh issue view <number> --repo <owner/repo> --json title,body,url,comments,state` (or `gh pr view` for a PR). Use to backfill context when a webhook message doesn't include everything you need.

## `transition(ref, label)`
`gh issue edit <number> --repo <owner/repo> --add-label "<label>"` (e.g. `pipeline:planning`, `pipeline:implementing`, `pipeline:done`) so the tracker's own board reflects pipeline stage without a human syncing it by hand. Optional — skip if the repo has no such labels configured.

## Recovering a `runId` from a reply
The webhook message already has the recovered `runId` when one exists (the API extracts it from the `<!-- shogo:runId=... -->` marker in the issue/PR body before waking you). You should not need to parse it yourself; if a message arrives with no `runId` and you believe it should have one, `gh issue view` / `gh pr view` and look for the marker in the body.
