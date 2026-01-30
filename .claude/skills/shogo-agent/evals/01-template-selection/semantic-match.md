# Eval: Semantic Match - Indirect Keywords

**Level:** 2 (Semantic Mapping)
**Category:** Template Selection
**Difficulty:** Medium

## Purpose

Test the agent's ability to map semantically related requests to templates when exact keywords aren't used.

---

## Test Case 1: Task Management → Todo

### Input
```
"I need something to help me stay organized with my daily work"
```

### Expected Classification
- **Template:** todo-app
- **Confidence:** Medium
- **Reasoning:** "organized", "daily work" semantically maps to task management

### Expected Tool Calls
1. `template.copy({ template: "todo-app", name: "..." })`

### Validation
- [ ] Selected todo-app (not kanban, not crm)
- [ ] Recognized "organized" + "daily work" as task-related

---

## Test Case 2: Money Tracking → Expense Tracker

### Input
```
"Help me see where my money goes each month"
```

### Expected Classification
- **Template:** expense-tracker
- **Confidence:** Medium-High
- **Reasoning:** "money goes" implies expense tracking

### Expected Tool Calls
1. `template.copy({ template: "expense-tracker", name: "..." })`

### Validation
- [ ] Selected expense-tracker
- [ ] Understood "where money goes" = expense tracking

---

## Test Case 3: Customer Work → CRM

### Input
```
"I run a small business and need to keep track of all my clients"
```

### Expected Classification
- **Template:** crm
- **Confidence:** High
- **Reasoning:** "business" + "clients" strongly indicates CRM

### Expected Tool Calls
1. `template.copy({ template: "crm", name: "..." })`

### Validation
- [ ] Selected crm
- [ ] "clients" mapped to customer management

---

## Test Case 4: Visual Project Management → Kanban

### Input
```
"I want to visualize my project workflow with draggable cards"
```

### Expected Classification
- **Template:** kanban
- **Confidence:** High
- **Reasoning:** "visualize", "workflow", "draggable cards" = kanban

### Expected Tool Calls
1. `template.copy({ template: "kanban", name: "..." })`

### Validation
- [ ] Selected kanban (not todo-app)
- [ ] Recognized visual/card-based request

---

## Test Case 5: Conversational AI → AI Chat

### Input
```
"Build me something I can talk to that uses AI"
```

### Expected Classification
- **Template:** ai-chat
- **Confidence:** Medium-High
- **Reasoning:** "talk to" + "AI" indicates chatbot

### Expected Tool Calls
1. `template.copy({ template: "ai-chat", name: "..." })`

### Validation
- [ ] Selected ai-chat
- [ ] Recognized conversational AI request

---

## Test Case 6: Warehouse → Inventory

### Input
```
"I need to know what's in stock at my warehouse"
```

### Expected Classification
- **Template:** inventory
- **Confidence:** High
- **Reasoning:** "stock" + "warehouse" = inventory management

### Expected Tool Calls
1. `template.copy({ template: "inventory", name: "..." })`

### Validation
- [ ] Selected inventory
- [ ] Recognized warehouse/stock management need

---

## Scoring Rubric

For each test case:

| Criterion | Points |
|-----------|--------|
| Correct template selected | 50 |
| Reasonable confidence assessment | 20 |
| No unnecessary questions | 15 |
| Good explanation of choice | 15 |
| **Total per case** | **100** |

**Overall Score:** Average across all test cases

---

## Notes for Evaluation

- These tests require understanding context, not just keyword matching
- The agent should demonstrate reasoning about WHY it chose a template
- Medium confidence matches may include a brief mention of alternatives
- Agent should NOT ask clarifying questions for these - the intent is clear enough
