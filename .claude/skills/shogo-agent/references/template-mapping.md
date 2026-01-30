# Template Mapping Reference

This document provides detailed guidance for mapping user requests to templates.

## Keyword Extraction

When a user makes a request, extract key concepts:

1. **Domain Words**: What area? (tasks, finance, sales, inventory)
2. **Action Words**: What do they want to do? (track, manage, organize)
3. **Object Words**: What entities? (todos, expenses, customers, products)

## Template Scoring Algorithm

For each template, calculate a match score:

```
score = (exact_keyword_matches * 3) + 
        (semantic_matches * 2) + 
        (related_concept_matches * 1)
```

### Template: todo-app

**Exact Keywords (score +3 each):**
- "todo", "to-do", "task", "tasks", "checklist"

**Semantic Matches (score +2 each):**
- "track tasks", "manage tasks", "daily tasks"
- "to do list", "task list", "task tracker"

**Related Concepts (score +1 each):**
- "productivity", "organize", "remember"
- "daily", "list", "items"

**Example Matches:**
| Request | Score | Confidence |
|---------|-------|------------|
| "build a todo app" | 9 | High |
| "I need to track my tasks" | 5 | High |
| "help me organize my daily items" | 3 | Medium |

---

### Template: expense-tracker

**Exact Keywords (score +3 each):**
- "expense", "expenses", "budget", "spending"

**Semantic Matches (score +2 each):**
- "track spending", "manage money", "financial"
- "expense tracker", "budget app", "money manager"

**Related Concepts (score +1 each):**
- "finance", "money", "costs", "bills"
- "categories", "transactions"

**Example Matches:**
| Request | Score | Confidence |
|---------|-------|------------|
| "expense tracker for my budget" | 9 | High |
| "track my spending" | 5 | High |
| "manage my finances" | 3 | Medium |

---

### Template: crm

**Exact Keywords (score +3 each):**
- "crm", "customer", "customers", "sales", "leads"

**Semantic Matches (score +2 each):**
- "sales pipeline", "customer management", "deal tracking"
- "contact management", "lead tracking"

**Related Concepts (score +1 each):**
- "business", "clients", "relationships", "pipeline"
- "deals", "opportunities", "accounts"

**Example Matches:**
| Request | Score | Confidence |
|---------|-------|------------|
| "build a CRM" | 9 | High |
| "customer relationship management" | 6 | High |
| "track my sales leads" | 5 | High |

---

### Template: inventory

**Exact Keywords (score +3 each):**
- "inventory", "stock", "warehouse", "products"

**Semantic Matches (score +2 each):**
- "stock management", "product tracking", "inventory system"
- "warehouse management", "stock levels"

**Related Concepts (score +1 each):**
- "suppliers", "items", "quantities", "reorder"
- "SKU", "catalog"

---

### Template: kanban

**Exact Keywords (score +3 each):**
- "kanban", "board", "cards", "columns"

**Semantic Matches (score +2 each):**
- "project board", "task board", "scrum board"
- "drag and drop", "workflow"

**Related Concepts (score +1 each):**
- "agile", "sprint", "project management"
- "lanes", "stages", "pipeline"

---

### Template: ai-chat

**Exact Keywords (score +3 each):**
- "chatbot", "ai chat", "chat bot", "assistant"

**Semantic Matches (score +2 each):**
- "AI assistant", "conversational AI", "chat interface"
- "chatbot app", "AI chat app"

**Related Concepts (score +1 each):**
- "conversation", "messages", "AI", "LLM"
- "talk to", "ask questions"

---

### Template: form-builder

**Exact Keywords (score +3 each):**
- "form builder", "forms", "survey", "questionnaire"

**Semantic Matches (score +2 each):**
- "create forms", "build forms", "dynamic forms"
- "survey builder", "questionnaire builder"

**Related Concepts (score +1 each):**
- "fields", "inputs", "responses", "collect data"

---

### Template: feedback-form

**Exact Keywords (score +3 each):**
- "feedback", "review", "ratings", "testimonials"

**Semantic Matches (score +2 each):**
- "user feedback", "collect feedback", "feedback form"
- "reviews system", "rating system"

**Related Concepts (score +1 each):**
- "opinions", "comments", "suggestions"

---

### Template: booking-app

**Exact Keywords (score +3 each):**
- "booking", "appointment", "scheduling", "reservation"

**Semantic Matches (score +2 each):**
- "appointment scheduler", "booking system", "calendar booking"
- "schedule appointments", "book time"

**Related Concepts (score +1 each):**
- "calendar", "time slots", "availability"
- "meetings", "sessions"

---

## Confidence Thresholds

| Score | Confidence | Action |
|-------|------------|--------|
| ≥6 | High | Proceed with template |
| 3-5 | Medium | Proceed but mention alternative |
| 1-2 | Low | Ask clarifying question |
| 0 | None | Offer template list or custom path |

## Disambiguation Rules

When multiple templates score similarly:

1. **Prefer More Specific**: "track expenses" → expense-tracker (not todo-app)
2. **Check Context**: "board for tasks" → kanban (not todo-app)
3. **Ask Once**: "Would you prefer a simple list (todo) or a board view (kanban)?"
