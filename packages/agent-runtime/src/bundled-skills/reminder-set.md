---
name: reminder-set
version: 1.0.0
description: Set reminders that will be checked on heartbeat ticks
trigger: "remind me|set reminder|don't forget|remember to"
tools: [read_file, write_file, memory_write]
---

# Set Reminder

When the user wants to set a reminder:

1. Parse the reminder text and timing from the user's message
2. Write the reminder to MEMORY.md in a structured format
3. Confirm the reminder was set with the parsed details

## Reminder Format in MEMORY.md

```markdown
## Active Reminders
- [ ] [Reminder text] — Due: [date/time] (set: [today])
```

## On Heartbeat
When checking reminders during heartbeat:
- Read MEMORY.md for active reminders
- Check if any are due now or overdue
- Alert the user about due reminders
- Move completed reminders to a "Past Reminders" section
