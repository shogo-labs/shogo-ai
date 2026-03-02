---
name: habit-track
version: 2.0.0
description: Track daily habits on a canvas kanban board with streaks
trigger: "habit|track habit|log habit|check habits|my habits|streak|add habit"
tools: [canvas_create, canvas_update, canvas_api_schema, canvas_api_seed, memory_read, memory_write]
---

# Habit Tracker

Build and manage a habit tracking kanban board:

1. **Setup** — Use canvas_api_schema for habit CRUD:
   - Fields: name, description, status (Not Started/In Progress/Done), streak, lastCompleted
2. **Build canvas** — Habit tracker board:
   - KPIs: total habits, active today, best streak
   - Kanban: 3-column Grid (Not Started / In Progress / Done)
   - Each habit is a Card with: name, streak Badge, action Button
   - Buttons with mutations: "Start" (→ In Progress), "Done" (→ Done), "Reset" (→ Not Started)
3. **Add habit** — When user says "add habit [name]":
   - Create via canvas_api_seed with status "Not Started" and streak 0
4. **Complete** — When user says "done [habit]" or clicks Done button:
   - Update status to Done, increment streak, set lastCompleted to today
5. **Streaks** — Track streaks in memory:
   - Increment when completed on consecutive days
   - Reset to 0 if a day is missed
   - Celebrate milestones (7, 30, 100 days)
6. **Reset daily** — On morning heartbeat, move all "Done" items back to "Not Started" for the new day

Ensure all buttons use mutations so they work without agent round-trips.
