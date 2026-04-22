---
name: auto-plan
version: 1.0.0
description: Daily prioritizer — build and re-rank the founder's top 3 priorities from calendar, inbox, open decisions, and goals
trigger: "plan my day|daily plan|priorities|auto plan|re-rank|what should i do today"
tools: [tool_search, tool_install, canvas_create, canvas_update, canvas_api_bind, memory_write]
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

Write the plan to the Daily Plan canvas surface. Save a snapshot to memory so EOD review can compare plan vs. reality.
