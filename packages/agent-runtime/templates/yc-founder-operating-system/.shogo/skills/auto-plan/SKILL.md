---
name: auto-plan
version: 1.0.0
description: Daily prioritizer — build and re-rank the founder's top 3 priorities from calendar, inbox, open decisions, and goals
trigger: "plan my day|daily plan|priorities|auto plan|re-rank|what should i do today"
tools: [tool_search, tool_install, edit_file, read_file, shell_exec, memory_write]
---

# Auto-Plan

You generate and maintain the founder's daily priority list. Run once at the start of the day, then re-run mid-day if priorities shift.

## Inputs

- Calendar for today and tomorrow
- Inbox items needing a founder decision
- Open items in the Decision Log
- Quarterly priorities from `AGENTS.md` → User section
- Yesterday's EOD digest (what slipped)

## Ranking Rule

Score each candidate item by:
- **Impact** — does it move a quarterly priority? (high weight)
- **Reversibility** — irreversible decisions jump the queue
- **Time-sensitivity** — deadline today or this week?
- **Unblocks-others** — does this unblock the team? (medium weight)

Pick the **top 3**. Never more. Everything else goes in a "maybe if time" list.

## Output Template

```
DATE: <today>
FOCUS: <one phrase that describes today's mission>

TOP 3:
1. <priority> — <outcome, time estimate>
2. <priority> — <outcome, time estimate>
3. <priority> — <outcome, time estimate>

DEEP WORK BLOCKS:
- <HH:MM–HH:MM> — <what>
- <HH:MM–HH:MM> — <what>

MEETING PREP NEEDED:
- <meeting> — <what to prep, 5-min ask>

DECISIONS OWED:
- <decision> — <who's waiting, deadline>

MAYBE IF TIME:
- <item>
- <item>

CUT FROM TODAY: <what the founder should say no to>
```

## Persistence

The Daily Plan surface (`src/surfaces/DailyPlan.tsx`) reads from the
auto-generated API backed by `prisma/schema.prisma`. Persist the plan by
POSTing to the relevant resources — never mock data in `.data.json` files.

```
POST /api/priorities        { date, position, title, outcome, estimate }
POST /api/deep-work-blocks  { date, start, end, task }
POST /api/meeting-preps     { date, title, when, prep }
PUT  /api/daily-metrics/:id { focusHours, meetings, openDecisions, slippedYesterday }
```

Replace today's rows before inserting new ones (DELETE existing priorities for
`date` first) so re-running the skill cleanly re-ranks rather than duplicating.
Save a snapshot of the plan to memory so EOD review can compare plan vs. reality.

If you need a new table or column, edit `prisma/schema.prisma`, run
`bun x prisma migrate dev --name <short_description>`, and **commit** the new
files under `prisma/migrations/` with the schema change.
