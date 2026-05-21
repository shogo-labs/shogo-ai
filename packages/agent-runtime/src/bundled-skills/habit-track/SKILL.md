---
name: habit-track
version: 2.0.0
description: Track daily habits on a canvas kanban board with streaks
trigger: "habit|track habit|log habit|check habits|my habits|streak|add habit"
tools: [memory_read, write_file]
---

# Habit Tracker

Build and manage a habit tracking kanban board:

1. **Setup** — Define habit data shape in the canvas:
   - Fields: name, description, status (Not Started/In Progress/Done), streak, lastCompleted
2. **Build canvas** — Habit tracker board (`write_file` canvas TSX):
   - KPIs: total habits, active today, best streak
   - Kanban: 3-column grid (Not Started / In Progress / Done)
   - Each habit is a card with: name, streak badge, action button
   - Buttons: "Start" (→ In Progress), "Done" (→ Done), "Reset" (→ Not Started) — handled as local React state in the canvas component
3. **Add habit** — When user says "add habit [name]":
   - Add a new row to the canvas with status "Not Started" and streak 0, then re-write the file
4. **Complete** — When user says "done [habit]":
   - Update status to Done, increment streak, set lastCompleted to today via `write_file`
5. **Streaks** — Track streaks in memory:
   - Increment when completed on consecutive days
   - Reset to 0 if a day is missed
   - Celebrate milestones (7, 30, 100 days)
6. **Reset daily** — On morning heartbeat, move all "Done" items back to "Not Started" for the new day
