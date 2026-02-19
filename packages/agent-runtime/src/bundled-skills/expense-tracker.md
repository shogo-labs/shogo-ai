---
name: expense-tracker
version: 1.0.0
description: Log and track expenses with categories and budget monitoring
trigger: "log expense|add expense|spending|budget|expenses|how much"
tools: [read_file, write_file]
---

# Expense Tracker

Manage expenses stored in expenses.md in the workspace.

## Commands

**Log expense:** Record a new expense
- Parse amount, category, and description from natural language
- Append to expenses.md with today's date

**View expenses:** Show spending summary
- Group by category
- Show totals for this week/month
- Compare against budget if set

**Budget check:** How spending compares to budget

## File Format (expenses.md)

```markdown
# Expenses

## Budget
- Monthly total: $X,XXX
- Food: $XXX
- Transport: $XXX

## February 2026
| Date | Category | Amount | Description |
|------|----------|--------|-------------|
| 2/19 | Food | $15.50 | Lunch |
```

If no expenses.md exists, create one with the template above.
