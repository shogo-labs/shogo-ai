# Eval: Multi-Turn - Complete Workflow

**Level:** 3 (Multi-Turn Conversation)
**Category:** Complete User Journey
**Difficulty:** Hard

## Purpose

Test the agent's ability to handle a complete user journey from initial request through customization.

---

## Scenario 1: Build → Customize Theme → Add Feature

### Turn 1: Initial Request
**User:** "Build me a todo app"

**Expected:**
- Select todo-app template
- Call template.copy
- Report success
- Offer customization

### Turn 2: Theme Change
**User:** "Make it look more professional with blue colors"

**Expected:**
- Recognize theme request
- Apply glacier (blue) theme
- Update index.css
- Confirm change

### Turn 3: Feature Request
**User:** "Can you add due dates to the tasks?"

**Expected:**
- Modify Prisma schema to add dueDate field
- Update components to show date picker
- Update list view to display due dates
- Confirm changes

### Turn 4: Satisfaction Check
**User:** "Perfect, thanks!"

**Expected:**
- Acknowledge completion
- Offer any final adjustments
- Not ask unnecessary questions

### Complete Validation
- [ ] Maintained context across all turns
- [ ] Did not recreate project for customizations
- [ ] Each turn addressed specific request
- [ ] Final state has all requested features

---

## Scenario 2: Ambiguous → Clarify → Build → Refine

### Turn 1: Ambiguous Request
**User:** "I need something for my business"

**Expected:**
- Recognize ambiguity
- Ask ONE clarifying question
- Offer business-relevant options (CRM, inventory, expense-tracker)

### Turn 2: Clarification
**User:** "I need to track my customers and deals"

**Expected:**
- Recognize CRM need
- Proceed with crm template
- Call template.copy
- Report success

### Turn 3: Refinement
**User:** "Can you add a notes field to the contacts?"

**Expected:**
- Modify Contact model in Prisma
- Update contact form to include notes
- Confirm change

### Complete Validation
- [ ] Asked appropriate clarifying question (Turn 1)
- [ ] Used clarification to select correct template (Turn 2)
- [ ] Made targeted modification, not full rebuild (Turn 3)

---

## Scenario 3: Wrong Template → Correction → Continue

### Turn 1: Initial Request
**User:** "Build a task board"

**Expected:**
- Might select kanban OR todo-app (both reasonable)

### Turn 2: Correction
**User:** "Actually I wanted a simple list, not a board"

**Expected:**
- Understand user wants todo-app instead
- Ask if they want to switch
- OR if already on todo-app, confirm it's a list view

### Turn 3: Continue
**User:** "Yes, a simple list is fine"

**Expected:**
- If switching: Create todo-app project
- If staying: Confirm current setup works
- Offer customization

### Complete Validation
- [ ] Handled correction gracefully
- [ ] Offered clear options
- [ ] Completed the workflow

---

## Scenario 4: Feature-Rich Request

### Turn 1: Complex Initial Request
**User:** "Build an expense tracker with categories, recurring expenses, and monthly reports"

**Expected:**
- Start with expense-tracker template
- Acknowledge the feature requests
- Explain what's included vs what needs customization

### Turn 2: Status Check
**User:** "Which features are ready?"

**Expected:**
- Categories: Built into template ✓
- Recurring expenses: Would need to add
- Monthly reports: Would need to add
- Clear communication of status

### Turn 3: Add Feature
**User:** "Let's add recurring expenses"

**Expected:**
- Modify schema for recurring flag
- Add frequency field (daily/weekly/monthly)
- Update UI for recurring indicator
- Confirm implementation

### Complete Validation
- [ ] Correctly identified template capabilities
- [ ] Honest about what needs customization
- [ ] Successfully added requested feature

---

## Scoring Rubric

Each scenario:

| Criterion | Points |
|-----------|--------|
| Context retention across turns | 25 |
| Appropriate response per turn | 25 |
| No unnecessary recreations | 20 |
| Clear communication | 15 |
| Successful completion | 15 |
| **Total** | **100** |

---

## Anti-Patterns

- [ ] ❌ Starting from scratch on Turn 3+ 
- [ ] ❌ Forgetting what template was used
- [ ] ❌ Asking questions already answered
- [ ] ❌ Ignoring user's correction
- [ ] ❌ Not acknowledging limitations honestly

---

## Context Retention Checklist

Agent should remember throughout conversation:
- [ ] Which template was used
- [ ] Project name
- [ ] What customizations were already made
- [ ] User's stated preferences
- [ ] What features user said they wanted
