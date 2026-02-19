---
name: reminder-check
version: 1.0.0
description: Check for reminders, deadlines, and upcoming tasks
trigger: "check reminders|what's due|upcoming|deadlines|schedule"
tools: [memory_read]
---

# Reminder Check

When the user asks about reminders or deadlines:

1. **Read** MEMORY.md for stored reminders and deadlines
2. **Read** recent daily logs for context
3. **Evaluate** what's due today, overdue, and upcoming
4. **Present** in priority order

## Output Format

### Reminders & Deadlines

**Overdue:**
- [Task] — was due [date]

**Due Today:**
- [Task] — due by [time]

**Upcoming This Week:**
- [Task] — due [date]

**No Deadline:**
- [Task] — pending

If no reminders are found, suggest the user set some up.
