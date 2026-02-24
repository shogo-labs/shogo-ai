---
name: jira-tickets
version: 1.0.0
description: Manage and track Jira, Linear, or GitHub Issues — list, create, update, and prioritize tickets
trigger: "jira|ticket|issue|linear|backlog|sprint|kanban|bug report|feature request"
tools: [web_fetch, read_file, write_file, exec]
---

# Issue Tracker Management

Manage tickets and issues across popular project management tools.

## Supported Platforms

- **Jira** — via REST API or web scraping
- **Linear** — via GraphQL API
- **GitHub Issues** — via `gh` CLI or web_fetch

## Commands

**List tickets:** Show open issues with filters
- Filter by status (open, in progress, done)
- Filter by assignee, label, or priority
- Sort by creation date, priority, or last updated

**Create ticket:** Create a new issue
- Parse title, description, priority, and labels from natural language
- Assign to team member if specified

**Update ticket:** Change status, priority, or assignee
- Support transitions (To Do → In Progress → Done)

**Sprint summary:** Show current sprint status
- Tickets completed vs remaining
- Blocked tickets
- Velocity metrics

## Output Format

**Sprint: Sprint 42** | Feb 17–28, 2026
**Progress:** ████████░░ 80% (8/10 tickets)

| Key | Title | Status | Priority | Assignee |
|-----|-------|--------|----------|----------|
| PROJ-123 | Fix login bug | 🔵 In Progress | High | @alice |
| PROJ-124 | Add dark mode | ⬜ To Do | Medium | @bob |
| PROJ-125 | Update docs | ✅ Done | Low | @carol |

## Guidelines

- Try `gh` CLI first for GitHub Issues
- For Jira/Linear, use web_fetch with API endpoints if tokens are available
- Fall back to tracking issues locally in issues.md if no API access
- Always show priority and status clearly

