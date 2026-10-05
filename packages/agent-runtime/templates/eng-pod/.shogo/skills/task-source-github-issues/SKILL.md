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

`gh` is already authenticated as this environment's GitHub App bot (`GH_TOKEN` is the installation token). Comments, reviews, and commits from these commands show up as that bot — the same account that opens pull requests. Do not run `gh auth login` and do not save a personal `GITHUB_TOKEN` over it.

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

**The very first time you embed a `runId` for an issue (posting the 5 options), also stamp the marker onto the issue's own body**, not just the comment:
```bash
gh issue edit <number> --repo <owner/repo> --body "$(gh issue view <number> --repo <owner/repo> --json body --jq .body)

<!-- shogo:runId=<runId> -->
"
```
This matters because the webhook payload for a later `issue_comment` event (e.g. the human's "Go with option 1" reply) contains the *issue's* body but only the *new* comment's body — never earlier comments. The API's recovery check (`extractRunId(issue.body) ?? extractRunId(comment.body)`) can only find a marker that's actually in one of those two places. A marker that lives solely in your own earlier options-comment is invisible to it, so a plain reply with no `runId` and no bot-mention gets silently dropped and the run stalls forever at "awaiting_pick" (found live running the L1 multi-project eval). Stamping the issue body once, right after minting the `runId`, is what makes every later reply on that issue recoverable. A PR's body carries its own marker the same way (see `implementer`'s instructions) — no separate edit needed there since the PR is created with the marker already in its body.

## `list()` / `get(ref)`
`gh issue view <number> --repo <owner/repo> --json title,body,url,comments,state` (or `gh pr view` for a PR). Use to backfill context when a webhook message doesn't include everything you need.

## `transition(ref, label)`
`gh issue edit <number> --repo <owner/repo> --add-label "<label>"` (e.g. `pipeline:planning`, `pipeline:implementing`, `pipeline:done`) so the tracker's own board reflects pipeline stage without a human syncing it by hand. Optional — skip if the repo has no such labels configured.

## Recovering a `runId` from a reply
The webhook message already has the recovered `runId` when one exists (the API extracts it from the `<!-- shogo:runId=... -->` marker in the issue/PR body before waking you). You should not need to parse it yourself; if a message arrives with no `runId` and you believe it should have one, `gh issue view` / `gh pr view` and look for the marker in the body.
