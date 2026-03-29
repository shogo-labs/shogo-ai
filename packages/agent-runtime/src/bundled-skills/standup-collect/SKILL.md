---
name: standup-collect
version: 2.0.0
description: Collect and compile daily standup updates from the team
trigger: "standup|daily update|what did|yesterday|today plan|blockers"
tools: [send_message, memory_read, write_file, canvas_create, canvas_update]
---

# Standup Collection

Facilitate daily standup updates:

1. **Prompt** — If a channel is configured, send standup prompt:
   ```
   🗓️ **Daily Standup**
   Share your update:
   - **Yesterday:** What did you complete?
   - **Today:** What are you working on?
   - **Blockers:** Anything blocking you?
   ```
2. **Collect** — Parse responses from the user (or team if multi-user channel)
3. **Compile** — Build standup summary:
   - Completed items grouped by person
   - Planned items for today
   - Active blockers highlighted
4. **Build canvas** — Update the sprint board or create a standup summary canvas
5. **Track** — Save standup data to memory for patterns:
   - Recurring blockers
   - Velocity trends
   - Stale tasks (planned but not started for >2 days)
6. **Notify** — Post compiled summary to team channel via `send_message`
