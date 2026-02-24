---
name: calendar-manage
version: 1.0.0
description: Create, list, update, and manage calendar events and appointments
trigger: "calendar|schedule|appointment|event|meeting at|book time|free time|availability"
tools: [read_file, write_file, memory_read, memory_write]
---

# Calendar Manager

Manage a calendar of events and appointments stored in the workspace calendar.md file.

## Commands

**Add event:** Create a new calendar event
- Parse date, time, duration, and attendees from natural language
- Detect conflicts with existing events
- Append to calendar.md in chronological order

**List events:** Show upcoming events
- Filter by day, week, or date range
- Highlight events happening today
- Show conflicts or double-bookings

**Update event:** Modify an existing event
- Change time, date, duration, or attendees
- Mark as cancelled if needed

**Check availability:** Find free time slots
- Scan calendar for gaps on a given day
- Suggest available meeting times

## File Format (calendar.md)

```markdown
# Calendar

## 2026-02-24 (Monday)
- 09:00–09:30 | Team standup | Attendees: Team
- 14:00–15:00 | Client meeting | Attendees: Jane, Bob
- 16:30–17:00 | 1:1 with manager

## 2026-02-25 (Tuesday)
- 10:00–11:00 | Sprint planning
- ~~13:00–14:00 | Cancelled: Vendor demo~~
```

## Guidelines

- Always check for conflicts before adding events
- Show times in 24h format for clarity
- When listing, highlight "now" and "next" events
- Offer to set reminders via memory_write for important events

