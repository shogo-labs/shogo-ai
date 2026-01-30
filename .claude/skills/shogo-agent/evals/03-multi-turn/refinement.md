# Eval: Multi-Turn - Refinement Requests

**Level:** 3 (Multi-Turn Conversation)
**Category:** Follow-up Handling
**Difficulty:** Medium

## Purpose

Test the agent's ability to handle follow-up requests after initial template setup.

---

## Conversation Flow 1: Theme Change

### Turn 1
**User:** "Build a todo app"

**Agent:** Creates todo app, reports success

### Turn 2
**User:** "Can you make it purple?"

### Expected Behavior
- Recognize this is a theme change request
- Apply the lavender theme to existing project

### Expected Response
> "I'll update the theme to purple."
> 
> [Modifies src/index.css or calls template.copy with theme if needed]
> 
> "Done! The app now has a lavender (purple) theme. Refresh the preview to see the changes."

### Validation Criteria
- [ ] Understood "purple" in context of previous app
- [ ] Did NOT create a new project
- [ ] Applied theme change correctly
- [ ] Mentioned refreshing preview

---

## Conversation Flow 2: Add Feature

### Turn 1
**User:** "Create an expense tracker"

**Agent:** Creates expense tracker, reports success

### Turn 2
**User:** "Can you add recurring expenses?"

### Expected Behavior
- Understand this is a feature addition request
- Modify the existing code to add recurring expense functionality

### Expected Response
> "I'll add recurring expenses to your tracker. This will need:
> 1. A new field on expenses to mark them as recurring
> 2. Logic to auto-create expenses on a schedule
> 
> Let me update the code..."
> 
> [Modifies Prisma schema and components]
> 
> "Done! You can now mark expenses as recurring. Would you like daily, weekly, or monthly options?"

### Validation Criteria
- [ ] Did NOT recreate the entire app
- [ ] Identified what changes were needed
- [ ] Made targeted code modifications
- [ ] Asked follow-up about implementation details

---

## Conversation Flow 3: Layout Change

### Turn 1
**User:** "Build a kanban board"

**Agent:** Creates kanban app, reports success

### Turn 2
**User:** "Can the cards show due dates?"

### Expected Behavior
- Modify existing card component
- Add due date field and display

### Expected Response
> "I'll add due dates to the kanban cards."
> 
> [Updates Card model and component]
> 
> "Cards now show due dates. I added a date picker when creating cards and the due date displays on each card. Overdue items are highlighted in red."

### Validation Criteria
- [ ] Modified existing components
- [ ] Added to data model appropriately
- [ ] Enhanced UI to show new field

---

## Conversation Flow 4: Undo Request

### Turn 1
**User:** "Create a CRM"

**Agent:** Creates CRM, reports success

### Turn 2
**User:** "Actually, I wanted a todo app instead"

### Expected Behavior
- Recognize user wants a different template
- Offer to replace or keep both

### Expected Response
> "No problem! Would you like me to:
> 1. Replace the CRM with a todo app (overwrites current project)
> 2. Keep both and switch to a new todo app
> 
> Which would you prefer?"

### Validation Criteria
- [ ] Recognized the "actually" indicates change of mind
- [ ] Offered clear options
- [ ] Did NOT just overwrite without asking
- [ ] Handled gracefully, not judgmentally

---

## Conversation Flow 5: Clarification After Ambiguity

### Turn 1
**User:** "Build something for tracking"

**Agent:** Asks clarifying question about what to track

### Turn 2
**User:** "My daily tasks"

### Expected Behavior
- Use the clarification to select todo-app
- Proceed without asking more questions

### Expected Response
> "Got it - I'll build a task tracker for your daily work."
> 
> [Calls template.copy with todo-app]
> 
> "Your task tracker is ready! You can add, complete, and delete tasks. Would you like me to customize anything?"

### Validation Criteria
- [ ] Used clarification to make selection
- [ ] Did NOT ask another question
- [ ] Proceeded to create immediately
- [ ] Selected correct template (todo-app)

---

## Context Retention Tests

### Test: Remember Project Name

**Turn 1:** "Build a todo app called work-tasks"
**Turn 2:** "Add categories to it"

**Validation:**
- [ ] Agent remembers project is called "work-tasks"
- [ ] Modifications target correct project
- [ ] No confusion about which project

### Test: Remember Template Type

**Turn 1:** "Create a CRM"
**Turn 2:** "Add a notes field to contacts"

**Validation:**
- [ ] Agent knows we're working on CRM
- [ ] Understands "contacts" refers to CRM contacts model
- [ ] Makes appropriate schema change

---

## Scoring Rubric

| Criterion | Points |
|-----------|--------|
| Correct context retention | 30 |
| Appropriate response type | 25 |
| No unnecessary recreation | 20 |
| Clear communication | 15 |
| Offers relevant next steps | 10 |
| **Total** | **100** |

---

## Anti-Patterns

- [ ] ❌ Recreating entire project for small changes
- [ ] ❌ Forgetting what was just created
- [ ] ❌ Asking questions already answered
- [ ] ❌ Losing track of project name/type
- [ ] ❌ Not acknowledging the follow-up context
