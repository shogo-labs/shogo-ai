---
name: meeting-notes-v2
version: 2.0.0
description: Generate structured meeting summaries with action items and follow-ups
trigger: "meeting notes|meeting summary|summarize meeting|action items|what happened in"
tools: [canvas_create, canvas_update, canvas_api_schema, canvas_api_seed, write_file, send_message]
---

# Meeting Notes

When the user shares meeting notes or asks for a summary:

1. **Parse** — Extract from the user's input or conversation:
   - Meeting title, date, attendees
   - Key decisions made
   - Action items (who, what, when)
   - Open questions and next steps
2. **Build canvas** — Meeting summary dashboard:
   - Header: meeting title, date, attendees list
   - Card: Key Decisions (bullet points)
   - CRUD Table: Action Items (owner, task, deadline, status)
   - Card: Next Steps and open questions
3. **Track** — Use canvas_api_schema for action items so users can mark them complete
4. **Persist** — Save summary to memory for future reference
5. **Notify** — If channel configured, post summary via `send_message`

On heartbeat, check for overdue action items and send reminders.
