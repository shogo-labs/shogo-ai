# Eval: Edge Cases - Competing Templates

**Level:** 4 (Edge Cases)
**Category:** Template Selection
**Difficulty:** Hard

## Purpose

Test the agent's ability to choose correctly when multiple templates could apply.

---

## Test Case 1: Todo vs Kanban

### Input
```
"I need to track tasks for my project"
```

### Analysis
- "track tasks" → todo-app (task tracking)
- "project" → kanban (project management)

### Expected Behavior
**Prefer:** todo-app (simpler, "track tasks" is direct match)

OR ask:
> "I can help with that! Would you prefer:
> - A **simple task list** (todo app) - great for personal tasks
> - A **project board** (kanban) - better for team projects with stages
> 
> Which fits your needs better?"

### Validation Criteria
- [ ] Recognized potential ambiguity
- [ ] Either chose simpler option OR asked ONE question
- [ ] Did NOT randomly pick kanban

---

## Test Case 2: Expense Tracker vs Inventory

### Input
```
"Help me track what I'm spending on supplies"
```

### Analysis
- "spending" → expense-tracker
- "supplies" → inventory

### Expected Behavior
**Prefer:** expense-tracker (spending is the action being tracked)

### Validation Criteria
- [ ] Selected expense-tracker
- [ ] "spending" weighted higher than "supplies"
- [ ] Did NOT select inventory

---

## Test Case 3: CRM vs Booking

### Input
```
"I need to manage my client appointments"
```

### Analysis
- "client" → CRM
- "appointments" → booking-app

### Expected Behavior
**Prefer:** booking-app (appointments is more specific)

OR ask if they need full CRM features or just scheduling.

### Validation Criteria
- [ ] Recognized dual signals
- [ ] "appointments" is more specific, should weight higher
- [ ] Made reasonable choice or asked

---

## Test Case 4: Form Builder vs Feedback Form

### Input
```
"I want to collect feedback through a form"
```

### Analysis
- "feedback" → feedback-form
- "form" → form-builder

### Expected Behavior
**Prefer:** feedback-form (more specific to use case)

### Rationale
Form-builder is for creating ARBITRARY forms. Feedback-form is specifically optimized for feedback collection. The specific template should win.

### Validation Criteria
- [ ] Selected feedback-form
- [ ] Recognized specificity hierarchy

---

## Test Case 5: Kanban vs Todo with Visual

### Input
```
"Task management with drag and drop"
```

### Analysis
- "task management" → todo-app
- "drag and drop" → kanban

### Expected Behavior
**Prefer:** kanban (drag-and-drop is a distinguishing feature)

### Validation Criteria
- [ ] Selected kanban
- [ ] "drag and drop" indicates visual board preference
- [ ] Did NOT select todo-app

---

## Test Case 6: Multiple Keywords

### Input
```
"CRM with inventory tracking"
```

### Analysis
User wants BOTH capabilities in one app.

### Expected Behavior
1. Acknowledge both needs
2. Explain templates are focused on one domain
3. Offer to start with one and potentially customize

### Expected Response
> "That's a combination of two different systems. I have separate templates for:
> - **CRM** - Customer and sales management
> - **Inventory** - Stock and product tracking
> 
> Would you like to start with one and I can add features from the other? Most businesses start with CRM and add inventory tracking later."

### Validation Criteria
- [ ] Did NOT pretend one template does both
- [ ] Offered reasonable path forward
- [ ] Suggested which to prioritize

---

## Decision Priority Rules

When templates compete, apply these rules in order:

1. **Specificity wins**: More specific template > general template
2. **Action verb wins**: What they want to DO matters most
3. **Feature mention wins**: Specific features (drag-drop, recurring, etc.)
4. **Simplicity default**: When equal, prefer simpler template
5. **Ask if truly equal**: When confidence is equal, ask ONE question

---

## Scoring Rubric

| Criterion | Points |
|-----------|--------|
| Correct final selection | 35 |
| Reasonable decision logic | 25 |
| Handled ambiguity appropriately | 20 |
| Clear explanation (if asked) | 10 |
| No random guessing | 10 |
| **Total** | **100** |

---

## Template Specificity Hierarchy

From most specific to most general:

1. **feedback-form** - Only for feedback
2. **booking-app** - Only for appointments
3. **ai-chat** - Only for chatbots
4. **expense-tracker** - Finance-specific tracking
5. **inventory** - Product-specific tracking
6. **crm** - Customer-specific management
7. **kanban** - Visual project management
8. **form-builder** - General form creation
9. **todo-app** - General task tracking (most general)

When in doubt, the MORE SPECIFIC template should be preferred if keywords match.
