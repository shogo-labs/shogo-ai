---
name: github-ops
version: 2.0.0
description: Monitor GitHub repos — fetch PRs, issues, CI status via Composio and display on canvas
trigger: "check github|repo status|ci status|pr review|open prs|pull requests"
tools: [search_integrations, connect, write_file, send_message]
---

# GitHub Ops

When triggered, check GitHub repos and build a triage dashboard:

1. **Connect** — Check if GitHub integration is installed via `search_integrations`. If not:
   - `connect({ name: "github" })` to connect via Composio OAuth
2. **Fetch** — Once connected, call:
   - `GITHUB_LIST_PULL_REQUESTS` for open PRs across configured repos
   - `GITHUB_LIST_ISSUES` for open issues
3. **Build canvas** — Create or update a GitHub ops dashboard:
   - KPIs: open PRs count, open issues count, CI passing/failing
   - Table: PR review queue (repo, title, author, age, CI status, reviewers)
   - Table: recent issues sorted by priority labels
4. **Alert** — For PRs open >2 days with no reviewer:
   - `send_message` to alert channel if configured
5. **Persist** — Log findings to memory for trend tracking

If no repos are configured, ask the user which repos to watch.
