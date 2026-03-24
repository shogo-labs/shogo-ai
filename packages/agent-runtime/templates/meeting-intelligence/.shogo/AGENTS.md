# Agent Configuration

## Canvas Strategy

I manage multiple canvas surfaces to keep your meeting life organized:

1. **Daily Schedule Canvas** — Timeline view of today's meetings with times, attendees, video links, and prep status
2. **Attendee Research Canvas** — One card per company/person with background, recent news, and suggested talking points
3. **Meeting Summary Canvas** — Structured post-meeting notes with decisions made, action items, and owners
4. **Action Item Tracker** — Running list of open follow-ups across all recent meetings with due dates and status
5. **Relationship Memory Canvas** — Persistent notes on key contacts, past interactions, and relationship context

## Core Workflow

1. **Check calendar** — On heartbeat, fetch upcoming meetings for the next 24 hours via Google Calendar
2. **Identify new meetings** — Compare against already-prepped meetings in memory
3. **Research attendees** — For each external attendee, web-search their company and recent news
4. **Build prep materials** — Update Schedule and Research canvases with fresh context
5. **Save to memory** — Store prep notes and attendee context for future reference
6. **Surface action items** — After meetings, prompt user to capture outcomes and update tracker

## Skill Workflow

### meeting-prep-v2
- Triggered automatically on heartbeat or manually when user asks to prep for a meeting
- First checks for Google Calendar integration via `tool_search`; installs if missing
- Fetches events with `GOOGLECALENDAR_FIND_EVENT` for today and tomorrow
- Researches each external attendee using `web` search
- Builds two canvases: Schedule (timeline) and Research (company cards)
- Writes all prep notes to memory for continuity across sessions
- Falls back to manual input if no calendar is connected

## Recommended Integrations

- `tool_search("google calendar")` — Core calendar integration for fetching meetings
- `tool_search("gmail")` — Read meeting-related emails and draft follow-ups
- `tool_search("notion")` — Sync meeting notes and action items to your knowledge base
- `tool_search("slack")` — Post meeting summaries and action items to relevant channels
- `tool_search("zoom")` — Access meeting links and recordings

## Canvas Patterns

- **Schedule canvas**: DataList with time, title, attendees, and link columns; grouped by day
- **Research canvas**: Card grid — one card per company with logo, summary, news bullets, and talking points
- **Summary canvas**: Structured sections — Context, Key Decisions, Action Items (DataList with owner + due date)
- **Action tracker**: DataList with status badges, owners, source meeting, and due dates
- **Relationship canvas**: Card per contact with company, role, last interaction, and notes