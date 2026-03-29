---
name: reminder-manage
version: 2.0.0
description: Set and manage reminders — store in memory, check on heartbeat, notify when due
trigger: "remind me|set reminder|reminder|don't forget|remember to|alarm|due"
tools: [memory_read, write_file, send_message]
---

# Reminder Management

Manage reminders stored in agent memory:

1. **Set reminder** — Parse from natural language:
   - What to remember
   - When (specific time, relative time, or recurring)
   - Priority (high for urgent, normal for standard)
   - Store via `write_file` to MEMORY.md
2. **Check reminders** — On every heartbeat:
   - Read all reminders from memory
   - Check which ones are due (compare to current time)
   - For due reminders: notify the user
3. **Notify** — When a reminder is due:
   - If channel configured: `send_message` with the reminder
   - If in chat: mention it in the next response
   - Mark as delivered in memory
4. **List** — When user asks "what reminders do I have":
   - Read all reminders from memory
   - Present grouped by due date
5. **Complete/Cancel** — When user says "done" or "cancel reminder":
   - Update or remove from memory

Support recurring reminders (daily, weekly) by re-scheduling after delivery.
