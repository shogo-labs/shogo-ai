---
name: daily-summary
version: 1.0.0
description: Generate an end-of-day summary of activities and findings
trigger: "daily summary|end of day|eod|wrap up|day in review"
tools: [memory_read, memory_write]
---

# Daily Summary

When triggered, compile a summary of today's activities:

1. **Read** today's daily memory log
2. **Read** MEMORY.md for ongoing context
3. **Compile** a structured summary covering:
   - Tasks completed
   - Key findings or decisions
   - Pending items for tomorrow
   - Any alerts or issues that arose
4. **Write** the summary to today's daily memory

## Output Format

### Daily Summary — [Date]

**Completed:**
- [Task/activity 1]
- [Task/activity 2]

**Key Findings:**
- [Important discovery or decision]

**Pending for Tomorrow:**
- [ ] [Task to follow up on]

**Notes:**
- [Any additional context]
