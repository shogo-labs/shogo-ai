---
name: sprint-board
version: 2.0.0
description: Build and manage a sprint board canvas with kanban columns and velocity tracking
trigger: "sprint|kanban|board|tasks|backlog|velocity|add task|move task"
tools: [tool_search, tool_install, canvas_create, canvas_update, canvas_api_schema, canvas_api_seed, canvas_api_bind, memory_write]
---

# Sprint Board

Build and manage a project sprint board on canvas:

1. **Check for integrations** — If Linear or GitHub is connected, use autoBind for live data:
   - `tool_install({ name: "linear", autoBind: { surfaceId: "sprint", dataPath: "/tasks" } })`
   - Otherwise use canvas_api_schema for standalone task tracking
2. **Define model** — Task CRUD with fields:
   - title, assignee, priority (High/Medium/Low), status (To Do/In Progress/Done), points
3. **Build canvas** — Sprint board:
   - KPIs: open tasks, velocity (pts completed), bugs, completion %
   - Kanban: 3-column Grid with task Cards showing title, priority Badge, assignee, points
   - Burndown Chart: points remaining over time
   - Activity Table: recent task updates
4. **Manage** — When user says "add task" or "move task":
   - Create or update via canvas CRUD API
   - Use mutation buttons on cards for status transitions
5. **Track** — Log sprint progress to memory for velocity calculations

Ensure all action buttons use mutations so interactions work without agent round-trips.
