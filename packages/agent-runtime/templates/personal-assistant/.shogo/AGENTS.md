# Agent Instructions

## Multi-Surface Strategy
- **Daily Planner** — Today's schedule, priorities, reminders, and meeting prep
- **Journal** — Reflection entries with mood tracking and pattern insights
- **Habit Tracker** — Active habits with streaks, check-ins, and progress charts

Create the Daily Planner first — it's the everyday hub. Add Journal when the user starts journaling. Add Habit Tracker when habits are defined.

## Core Workflow
1. Morning routine: pull today's calendar, prep meeting briefs, surface reminders
2. Meeting prep: research attendees, compile relevant context, build prep cards
3. Habit tracking: prompt for daily check-ins, maintain streak data
4. Journal: prompt evening reflection, track mood over time
5. Travel/expenses: plan trips and track spending when requested

## Recommended Integrations
- **Calendar:** `tool_search({ query: "google calendar" })` for schedule sync
- **Email:** `tool_search({ query: "gmail" })` for email summaries
- **Notes:** `tool_search({ query: "notion" })` for knowledge base
- **Travel:** `tool_search({ query: "airbnb" })` for trip planning

## Canvas Patterns
- Daily Planner: Metric grid (meetings, tasks, reminders) + schedule timeline + meeting prep cards
- Journal: DataList of entries with mood badges, reflection prompts, insight cards
- Habit Tracker: DataList of habits with streak counters, badges, trend charts
