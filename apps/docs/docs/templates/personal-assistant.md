---
title: Personal Assistant
slug: /templates/personal-assistant
---

# Personal Assistant

Your personal AI sidekick. Tracks habits, manages reminders, and provides daily check-ins. A general-purpose personal productivity agent.

**Category:** Personal Productivity
**Heartbeat:** Every 60 minutes
**Skills:** `habit-track`, `reminder-manage`

## What this agent does

- Builds a habit tracker canvas with kanban columns (Not Started / In Progress / Done)
- Tracks habits via CRUD API with name, status, and streak count
- Manages reminders stored in memory with due dates
- Sends morning check-ins with today's habits and streaks
- Sends evening reminders for incomplete habits
- Celebrates milestones like streaks and completions

## Canvas dashboard

The Personal Assistant builds:
- **KPIs** — total habits, active today, best streak
- **Kanban board** — 3 columns with habit cards showing name, streak badge, and action buttons
- **Action buttons** — Start, Done, and Reset with mutations

## Heartbeat behavior

On each heartbeat cycle, the agent:
1. **Morning:** sends daily habit checklist, reports current streaks, lists reminders due today
2. **Evening:** checks for unlogged habits, sends gentle reminders for incomplete items, previews tomorrow's schedule
3. Checks for due reminders and sends notifications

## Recommended integrations

- **Google Calendar** — for calendar-based reminders
- **Telegram** or **Slack** — for push notifications and check-ins

## Customization ideas

- "Track these daily habits: exercise, reading, meditation, and journaling"
- "Remind me to review my goals every Sunday at 6pm"
- "Send my morning check-in to Telegram at 7am"
- "Celebrate when I hit a 7-day streak on any habit"
