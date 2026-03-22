---
title: Meeting Prep
slug: /templates/meeting-prep
---

# Meeting Prep

Never walk into a meeting unprepared. Prepares for meetings by pulling calendar events, researching attendees, and building prep documents on canvas.

**Category:** Personal Productivity
**Heartbeat:** Every 60 minutes
**Skills:** `meeting-prep-v2`, `meeting-notes-v2`

## What this agent does

- Connects to Google Calendar to pull your meeting schedule
- Builds a schedule canvas with today's meetings, times, and attendees
- Researches external attendees by fetching their company websites
- Generates meeting prep documents with agendas and background context
- Tracks action items with owners and deadlines after meetings
- Follows up on overdue action items on heartbeat

## Canvas dashboard

The Meeting Prep agent builds:
- **Schedule timeline** — today's meetings with titles, times, and attendees
- **Research cards** — background on each external company (what they do, size, recent news)
- **Metrics** — meeting count, upcoming meetings, overdue action items

## Heartbeat behavior

On each heartbeat cycle, the agent:
1. Checks calendar for meetings in the next 2 hours
2. Auto-prepares agenda and attendee research for upcoming meetings
3. Checks for overdue action items and sends reminders
4. Saves prep notes to memory

## Post-meeting workflow

When you share meeting notes, the agent:
1. Generates a structured summary
2. Tracks action items with owners and deadlines in a CRUD table
3. Follows up on overdue items via heartbeat reminders

## Recommended integrations

- **Google Calendar** (required) — for calendar access
- **Gmail** — for sending follow-up emails
- **Slack** — for posting meeting summaries to channels

## Customization ideas

- "Prepare a briefing for my 2pm call with Acme Corp"
- "Track action items from today's standup"
- "Send me a Slack reminder 15 minutes before each meeting with the prep doc"
- "Research all external attendees for tomorrow's meetings"
