# Eval: Direct Match - All Templates

**Level:** 1 (Direct Mapping)
**Category:** Template Selection
**Purpose:** Comprehensive test of all template direct matches

## Overview

This eval covers direct match scenarios for ALL available templates to ensure the agent correctly identifies each one.

---

## Template: todo-app

### Inputs (all should select todo-app)
```
"Build a todo app"
"Create a todo list"
"I need a task tracker"
"Make a checklist app"
"Task management application"
```

### Key Indicators
- "todo", "task", "checklist", "to-do"

---

## Template: expense-tracker

### Inputs (all should select expense-tracker)
```
"Build an expense tracker"
"Create a budget app"
"Track my spending"
"Personal finance manager"
"Money tracking application"
```

### Key Indicators
- "expense", "budget", "spending", "finance", "money"

---

## Template: crm

### Inputs (all should select crm)
```
"Build a CRM"
"Customer relationship management"
"Sales pipeline app"
"Lead tracking system"
"Customer database"
```

### Key Indicators
- "crm", "customer", "sales", "leads", "clients", "deals"

---

## Template: inventory

### Inputs (all should select inventory)
```
"Build an inventory system"
"Stock management app"
"Product tracking"
"Warehouse management"
"Supplier management system"
```

### Key Indicators
- "inventory", "stock", "warehouse", "products", "suppliers"

---

## Template: kanban

### Inputs (all should select kanban)
```
"Build a kanban board"
"Project management with cards"
"Drag and drop task board"
"Agile project tracker"
"Scrum board application"
```

### Key Indicators
- "kanban", "board", "cards", "columns", "drag and drop", "agile"

---

## Template: ai-chat

### Inputs (all should select ai-chat)
```
"Build an AI chatbot"
"Create a chat assistant"
"Conversational AI app"
"AI-powered chat interface"
"Chatbot application"
```

### Key Indicators
- "chatbot", "ai chat", "assistant", "conversational ai"

---

## Template: form-builder

### Inputs (all should select form-builder)
```
"Build a form builder"
"Create dynamic forms"
"Survey creation tool"
"Questionnaire builder"
"Custom form application"
```

### Key Indicators
- "form builder", "forms", "survey", "questionnaire", "dynamic forms"

---

## Template: feedback-form

### Inputs (all should select feedback-form)
```
"Build a feedback form"
"User feedback collection"
"Rating system"
"Review collection app"
"Customer feedback tool"
```

### Key Indicators
- "feedback", "reviews", "ratings", "testimonials"

---

## Template: booking-app

### Inputs (all should select booking-app)
```
"Build a booking system"
"Appointment scheduler"
"Reservation app"
"Calendar booking tool"
"Scheduling application"
```

### Key Indicators
- "booking", "appointment", "scheduling", "reservation", "calendar"

---

## Validation Matrix

| Template | Must Select | Must NOT Select |
|----------|-------------|-----------------|
| todo-app | On "todo", "task" | On "project board" |
| expense-tracker | On "expense", "budget" | On "inventory", "stock" |
| crm | On "customer", "sales" | On "personal tasks" |
| inventory | On "stock", "products" | On "expenses" |
| kanban | On "board", "cards" | On simple "tasks" |
| ai-chat | On "chatbot", "AI assistant" | On "customer support" (could be crm) |
| form-builder | On "form builder" | On "feedback" alone |
| feedback-form | On "feedback", "reviews" | On "forms" alone |
| booking-app | On "booking", "appointment" | On "calendar" alone |

---

## Scoring

Each template test:
- 40 points: Correct template selection
- 20 points: No clarifying questions
- 20 points: Correct tool usage
- 10 points: No manual commands
- 10 points: Offers customization

**Total per template:** 100 points
**Overall pass threshold:** 70% average across all templates
