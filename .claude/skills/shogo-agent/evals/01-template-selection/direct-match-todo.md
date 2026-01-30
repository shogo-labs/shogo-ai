# Eval: Direct Match - Todo App

**Level:** 1 (Direct Mapping)
**Category:** Template Selection
**Difficulty:** Easy

## Input

```
"Build me a todo app"
```

## Expected Classification

- **Template:** todo-app
- **Confidence:** High (exact keyword match)
- **Reasoning:** "todo" is an exact keyword match for todo-app template

## Expected Tool Calls

1. `template.copy({ template: "todo-app", name: "<derived-name>" })`

**Note:** Agent may optionally call `template.list()` first, but it's not required for high-confidence matches.

## Expected Response Pattern

The response should:
1. Acknowledge the request briefly
2. Confirm using the todo-app template
3. Wait for setup completion
4. Report success and mention preview is ready
5. Offer to customize

**Example:**
> "I'll set up a todo app for you using the todo-app template."
> 
> [Calls template.copy]
> 
> "Your todo app is ready! The preview should now show a working task list. Would you like me to customize anything - like the styling, add categories, or change how tasks are displayed?"

## Validation Criteria

- [ ] Selected todo-app template (not expense-tracker, kanban, etc.)
- [ ] Called template.copy with correct template name
- [ ] Did NOT ask clarifying questions (request was clear)
- [ ] Did NOT run manual commands (bun install, prisma, etc.)
- [ ] Waited for template.copy to complete before declaring success
- [ ] Offered customization options after setup

## Anti-Patterns

- [ ] ❌ Asking "What kind of app do you want?" when "todo" was specified
- [ ] ❌ Selecting kanban because it also handles tasks
- [ ] ❌ Writing custom code instead of using template
- [ ] ❌ Running `bun install` after template.copy (it's automatic)

## Variations

Test these equivalent requests - all should select todo-app:

1. "Create a todo application"
2. "I need a todo list"
3. "Make me a task tracker"
4. "Build a simple task app"
5. "Todo app please"

## Scoring

| Criterion | Points | Notes |
|-----------|--------|-------|
| Correct template selection | 40 | Must be todo-app |
| No unnecessary questions | 20 | Should proceed directly |
| Proper tool usage | 20 | template.copy with right params |
| Good response quality | 10 | Clear, helpful messaging |
| Offers next steps | 10 | Customization options |
| **Total** | **100** | |

## Edge Cases

### With project name specified
**Input:** "Build a todo app called my-tasks"
**Expected:** `template.copy({ template: "todo-app", name: "my-tasks" })`

### With theme specified
**Input:** "Build a todo app with a purple theme"
**Expected:** `template.copy({ template: "todo-app", name: "...", theme: "lavender" })`

### Misspelled
**Input:** "Build a toDo app" or "Build a to-do app"
**Expected:** Still recognize as todo-app template
