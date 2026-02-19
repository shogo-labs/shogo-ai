---
name: task-manager
version: 1.0.0
description: Manage tasks — add, list, complete, and prioritize items in a task list
trigger: "add task|new task|list tasks|show tasks|complete task|done task|task list|my tasks"
tools: [read_file, write_file]
---

# Task Manager

Manage a task list stored in the workspace tasks.md file.

## Commands

**Add task:** Create a new task with optional priority and due date
- Parse priority (high/medium/low) and due date from natural language
- Append to tasks.md in the correct priority section

**List tasks:** Show all tasks grouped by priority
- Highlight overdue tasks
- Show completion status

**Complete task:** Mark a task as done
- Move to completed section with completion date

## File Format (tasks.md)

```markdown
# Tasks

## High Priority
- [ ] Task description (due: 2026-02-20)
- [x] Completed task (done: 2026-02-19)

## Medium Priority
- [ ] Task description

## Low Priority
- [ ] Task description

## Completed
- [x] Task (done: date)
```
