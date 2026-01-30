# Eval: Tool Usage - Error Handling

**Level:** 3 (Error Recovery)
**Category:** Tool Usage
**Difficulty:** Hard

## Purpose

Test the agent's ability to handle errors gracefully and recover.

---

## Test Case 1: Non-Existent Template

### Input
```
"Use the social-media template"
```

### Simulated Error
```json
{
  "ok": false,
  "error": {
    "code": "TEMPLATE_NOT_FOUND",
    "message": "Template \"social-media\" not found. Available templates: todo-app, expense-tracker, crm, inventory, kanban, ai-chat, form-builder, feedback-form, booking-app"
  }
}
```

### Expected Recovery
1. Acknowledge the error
2. List available templates
3. Suggest closest match or ask what they need

### Expected Response Pattern
> "I don't have a social-media template. Here are the available templates:
> 
> - todo-app, expense-tracker, crm, inventory, kanban, ai-chat, form-builder, feedback-form, booking-app
> 
> Would any of these work, or would you like me to build a custom solution?"

### Validation Criteria
- [ ] Did NOT crash or give up
- [ ] Explained the error clearly
- [ ] Provided actionable alternatives
- [ ] Offered to help further

---

## Test Case 2: Directory Exists Error

### Input
```
"Build a todo app"
```

### Simulated Error
```json
{
  "ok": false,
  "error": {
    "code": "DIR_EXISTS",
    "message": "Directory \"workspaces/todo-app\" already exists and is not empty. Use force: true to overwrite."
  }
}
```

### Expected Recovery
1. Explain that a project already exists
2. Ask if they want to overwrite or use different name

### Expected Response Pattern
> "There's already a project in that location. Would you like me to:
> 1. Overwrite it with a fresh todo app
> 2. Use a different project name
> 
> Which would you prefer?"

### If User Says "Overwrite"
```javascript
template.copy({
  template: "todo-app",
  name: "todo-app",
  force: true
})
```

### Validation Criteria
- [ ] Explained the conflict
- [ ] Offered both options (overwrite or rename)
- [ ] Used `force: true` if user chose overwrite
- [ ] Did NOT automatically overwrite without asking

---

## Test Case 3: Setup Failure

### Input
```
"Create an expense tracker"
```

### Simulated Error (partial success)
```json
{
  "ok": true,
  "projectDir": "/workspaces/expense-tracker",
  "setup": {
    "success": false,
    "error": "bun install failed: network timeout"
  }
}
```

### Expected Recovery
1. Acknowledge partial success
2. Explain what failed
3. Suggest retry or manual steps

### Expected Response Pattern
> "I copied the expense-tracker template, but the setup didn't complete - there was a network issue installing dependencies.
> 
> Would you like me to:
> 1. Try the setup again
> 2. Skip setup for now (you can run `bun install` later)
> 
> The template files are in place either way."

### Validation Criteria
- [ ] Acknowledged partial success
- [ ] Explained specific failure
- [ ] Provided recovery options
- [ ] Did NOT declare complete success

---

## Test Case 4: Invalid Parameter Handling

### Input
```
"Create a todo app with complexity level 'expert'"
```

### Expected Behavior
1. Recognize "expert" is not a valid complexity
2. Either ignore invalid param or ask for clarification

### Expected Response Pattern
> "I'll create a todo app for you. Note: complexity levels are 'beginner', 'intermediate', or 'advanced' - I'll use the default todo-app template which is beginner-friendly."

### Validation Criteria
- [ ] Did NOT crash on invalid parameter
- [ ] Proceeded with reasonable defaults
- [ ] Optionally mentioned the valid options

---

## Test Case 5: Network/Timeout Error

### Input
```
"Build a kanban board"
```

### Simulated Error
```json
{
  "ok": false,
  "error": {
    "code": "TIMEOUT",
    "message": "Operation timed out after 120 seconds"
  }
}
```

### Expected Recovery
1. Acknowledge the timeout
2. Suggest retry
3. Don't assume partial state

### Expected Response Pattern
> "The setup timed out - this can happen with slow network connections. Would you like me to try again?"

### Validation Criteria
- [ ] Clear explanation of timeout
- [ ] Offered to retry
- [ ] Did NOT assume success

---

## Test Case 6: Permission Error

### Input
```
"Create an inventory app"
```

### Simulated Error
```json
{
  "ok": false,
  "error": {
    "code": "PERMISSION_DENIED",
    "message": "Cannot write to /workspaces: permission denied"
  }
}
```

### Expected Recovery
1. Explain permission issue
2. This is likely a system issue, not user error
3. Suggest contacting support or checking setup

### Expected Response Pattern
> "I ran into a permission issue trying to create the project. This seems like a system configuration problem. Could you check that the workspace directory is writable, or try refreshing the page?"

### Validation Criteria
- [ ] Identified as system issue
- [ ] Did NOT blame user
- [ ] Suggested reasonable next steps

---

## Scoring Rubric

| Criterion | Points |
|-----------|--------|
| Graceful error acknowledgment | 25 |
| Clear explanation to user | 25 |
| Actionable recovery options | 25 |
| Appropriate retry logic | 15 |
| Professional tone | 10 |
| **Total** | **100** |

---

## Error Recovery Principles

1. **Never Crash Silently**: Always communicate what happened
2. **Explain Simply**: Technical errors should be translated for users
3. **Offer Options**: Give user control over recovery
4. **Don't Assume**: After errors, verify state before proceeding
5. **Stay Helpful**: Maintain positive, solution-oriented tone
