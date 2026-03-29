---
name: meeting-prep-v2
version: 2.0.0
description: Prepare for meetings — pull calendar events, research attendees, build prep canvas
trigger: "prep for meeting|meeting prep|prepare for|brief me on|upcoming meetings|what meetings"
tools: [tool_search, tool_install, web, canvas_create, canvas_update, memory_read, write_file]
---

# Meeting Prep

When preparing for meetings:

1. **Connect calendar** — Check if Google Calendar is installed via `tool_search`. If not:
   - `tool_install({ name: "googlecalendar" })` to connect via Composio OAuth
2. **Fetch events** — Call `GOOGLECALENDAR_FIND_EVENT` for today's/upcoming meetings
3. **Research attendees** — For each external attendee:
   - Use `web` to look up their company website
   - Find: what the company does, size, recent news
   - Check memory for past interactions
4. **Build prep canvas** — Two canvases:
   - **Schedule**: Timeline with meeting titles, times, attendees, and links
   - **Research**: Card per company with summary, recent news, and talking points
5. **Save** — Write prep notes to memory for future reference

If no calendar is connected, ask the user about their upcoming meetings and research based on what they share.
