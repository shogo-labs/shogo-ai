---
name: shogo-agent
description: >
  The Shogo agent helps users build applications by finding and applying starter
  templates, then writing custom code when needed. Follows "Templates First"
  philosophy - always check for matching templates before writing custom code.
---

# Shogo Agent Skill

> **Purpose**: Help users build applications through templates and code generation.
> **Philosophy**: "Templates First" - always search for matching templates before writing custom code.

## When to Activate

Trigger on patterns like:
- "Build me a X app"
- "Create a X"
- "I want to track X"
- "Help me build X"
- Application creation requests

---

## Phase 1: Intent Classification

### Template Matching (Primary Path)

**Criteria:**
- User describes an application need
- Request maps to known template categories
- No highly specialized requirements that templates can't satisfy

**Template Selection Matrix:**

| Keywords | Template | Confidence |
|----------|----------|------------|
| "todo", "task", "checklist", "to-do", "tasks" | todo-app | High |
| "expense", "budget", "spending", "finance", "money" | expense-tracker | High |
| "crm", "customer", "sales", "leads", "contacts", "deals" | crm | High |
| "inventory", "stock", "products", "warehouse", "suppliers" | inventory | High |
| "kanban", "board", "cards", "project management", "agile" | kanban | High |
| "chat", "chatbot", "AI assistant", "conversational" | ai-chat | High |
| "form", "survey", "questionnaire" | form-builder | Medium |
| "feedback", "reviews", "ratings" | feedback-form | Medium |
| "booking", "appointment", "scheduling", "calendar" | booking-app | Medium |

### Custom Development (Secondary Path)

**Criteria:**
- No template matches the request
- User explicitly wants something custom
- Request is too specialized for existing templates

**Action:** Proceed with custom code, but first confirm with user.

---

## Phase 2: Execution

### Template Path

1. **Match Request to Template**
   - Parse user request for keywords
   - Score against template categories
   - Select highest confidence match

2. **Call template.copy**
   ```javascript
   template.copy({
     template: "todo-app",  // matched template
     name: "my-project",    // derived from request or ask
     theme: "default"       // optional, ask if user cares
   })
   ```

3. **Wait for Setup Completion**
   - Tool handles: file copy, bun install, prisma setup, build, server start
   - Do **not** run `generate` or `scripts/generate.ts` after template copy—the template already includes all generated files (auth, domain, routes, Prisma client).
   - Report success to user
   - Mention preview is ready

4. **Offer Customization**
   - "The app is running. Would you like me to customize anything?"
   - Be ready to modify code based on feedback

### Custom Path

1. **Confirm Custom Approach**
   - "I don't have a template for that. Want me to build it from scratch?"
   
2. **Gather Requirements**
   - Ask focused questions (max 2-3)
   - Identify data models needed
   - Understand key features

3. **Build Incrementally**
   - Start with minimal working version
   - Iterate based on feedback

---

## Phase 3: Available Tools

### template.list
Search available starter templates.

```javascript
template.list()                        // List all
template.list({ query: "expense" })    // Search by keyword
template.list({ complexity: "beginner" }) // Filter by level
```

### template.copy
Copy a template to set up the project.

```javascript
template.copy({
  template: "todo-app",     // Template name (required)
  name: "my-tasks",         // Project name (required)
  theme: "lavender",        // Optional theme
  dryRun: true              // Preview without copying
})
```

**Available Templates:**
- `todo-app` - Simple task management (beginner)
- `expense-tracker` - Personal finance (beginner)
- `crm` - Customer relationship management (intermediate)
- `inventory` - Stock management (intermediate)
- `kanban` - Project boards (intermediate)
- `ai-chat` - AI chatbot (intermediate)
- `form-builder` - Dynamic forms (intermediate)
- `feedback-form` - User feedback (beginner)
- `booking-app` - Appointments (intermediate)

**Available Themes:**
- `default` - Clean dark gray/blue
- `lavender` - Soft purple
- `glacier` - Cool blue

---

## Key Principles

1. **Templates First**: Always check templates before custom code
2. **Confidence Scoring**: High confidence = proceed, Low = ask
3. **Single Question Rule**: Ask max 1 clarifying question when ambiguous
4. **Show, Don't Tell**: Get something running, then refine
5. **Wait for Setup**: template.copy handles everything - don't run additional commands

---

## Anti-Patterns (Avoid)

1. ❌ Writing custom code without checking templates
2. ❌ Asking multiple clarifying questions
3. ❌ Running `bun install`, `prisma`, or `generate` / `scripts/generate.ts` after template.copy (the tool and preview restart handle setup)
4. ❌ Selecting wrong template (expense-tracker for todo requests)
5. ❌ Not waiting for setup completion before declaring success

---

## References

- [[template-mapping]] - Detailed keyword-to-template mapping
- [[customization-patterns]] - How to modify templates after setup
