---
name: github-ops
version: 3.0.0
description: Monitor GitHub repos — fetch PRs, issues, CI status with the gh CLI and display on canvas
trigger: "check github|repo status|ci status|pr review|open prs|pull requests|github issues"
tools: [exec, write_file, send_message]
---

# GitHub Ops

When triggered, check GitHub repos and build a triage dashboard. Use the
pre-installed `gh` CLI via `exec` — do not `connect` GitHub or call `GITHUB_*` tools.

1. **Auth** — `exec({ command: "gh auth status" })`. If not authenticated, ask for a PAT, save it to `.env` as `GITHUB_TOKEN`, retry.
2. **Fetch** —
   - `exec({ command: "gh pr list --state open" })`
   - `exec({ command: "gh issue list --state open" })`
   - `exec({ command: "gh run list --limit 20" })` for CI
3. **Build canvas** — Create or update a GitHub ops dashboard:
   - KPIs: open PRs count, open issues count, CI passing/failing
   - Table: PR review queue (repo, title, author, age, CI status, reviewers)
   - Table: recent issues sorted by priority labels
4. **Alert** — For PRs open >2 days with no reviewer:
   - `send_message` to alert channel if configured
5. **Persist** — Log findings to memory for trend tracking

If no repo is in the current git remote, ask the user which `owner/repo` to watch and pass `-R owner/repo` to `gh`.
