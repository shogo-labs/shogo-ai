---
title: Project Board
slug: /templates/project-board
---

# Project Board

Your sprint command center. Sprint board with task tracking, velocity metrics, and team activity. Connects to Linear, GitHub, or works standalone.

**Category:** Development
**Heartbeat:** Every 60 minutes
**Skills:** `sprint-board`, `standup-collect`

## What this agent does

- Builds a sprint board canvas with kanban columns (To Do / In Progress / Done)
- Tracks tasks via CRUD API with title, assignee, priority, status, and points
- Calculates sprint velocity and shows burndown metrics
- Collects daily standups from team members (via connected channels)
- Alerts on tasks blocked for more than 1 day
- Connects to Linear or GitHub for live task and PR data

## Canvas dashboard

The Project Board agent builds:
- **KPIs** — open tasks, velocity (points/sprint), open bugs, test coverage
- **Kanban board** — 3-column grid with task cards showing title, priority, assignee, and points
- **Burndown chart** — points remaining over time
- **Activity table** — recent team actions

## Heartbeat behavior

On each heartbeat cycle, the agent:
1. Prompts team for standup updates (if channel configured)
2. Compiles standup summary
3. Updates task board with any status changes
4. Flags blocked items
5. Calculates current velocity and updates burndown chart
6. Highlights items at risk of not completing

## Recommended integrations

- **Linear** — for task management
- **GitHub** — for PR/commit activity
- **Slack** — for standup collection and notifications

## Customization ideas

- "Set up a sprint board for our 2-week sprints"
- "Connect Linear and sync tasks to the canvas board"
- "Collect daily standups from the team on Slack at 9am"
- "Track velocity and alert me if we're falling behind"
