---
name: sprint-board
version: 2.0.0
description: Build and manage a sprint board canvas with kanban columns and velocity tracking
trigger: "sprint|kanban|board|tasks|backlog|velocity|add task|move task"
tools: [search_integrations, connect, write_file]
---

# Sprint Board

Build and manage a project sprint board on canvas:

1. **Check for integrations** — If Linear or GitHub is connected, install via `connect`:
   - `connect({ name: "linear" })` to fetch live tasks from the integration
   - Otherwise maintain tasks in the canvas using local state and `write_file`
2. **Define model** — Task data shape:
   - title, assignee, priority (High/Medium/Low), status (To Do/In Progress/Done), points
3. **Build canvas** — Sprint board (`write_file` canvas TSX):
   - KPIs: open tasks, velocity (pts completed), bugs, completion %
   - Kanban: 3-column grid with task cards showing title, priority badge, assignee, points
   - Burndown Chart: points remaining over time
   - Activity Table: recent task updates
4. **Manage** — When user says "add task" or "move task":
   - Update canvas state and re-write the file
   - Status-transition buttons handle changes locally in the canvas component
5. **Track** — Log sprint progress to memory for velocity calculations
