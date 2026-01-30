# Eval: Tool Usage - Correct Parameters

**Level:** 2 (Tool Correctness)
**Category:** Tool Usage
**Difficulty:** Medium

## Purpose

Test that the agent passes correct parameters to template tools.

---

## Test Case 1: Basic template.copy

### Input
```
"Build a todo app called my-daily-tasks"
```

### Expected Tool Call
```javascript
template.copy({
  template: "todo-app",
  name: "my-daily-tasks"
})
```

### Validation Criteria
- [ ] `template` is exactly "todo-app" (not "todo", "todoapp", "todo_app")
- [ ] `name` matches user's specified name exactly
- [ ] No extra parameters added unnecessarily

---

## Test Case 2: With Theme

### Input
```
"Create an expense tracker with a purple theme"
```

### Expected Tool Call
```javascript
template.copy({
  template: "expense-tracker",
  name: "<any-valid-name>",
  theme: "lavender"
})
```

### Validation Criteria
- [ ] Mapped "purple" to "lavender" theme
- [ ] Included theme parameter
- [ ] Template name is correct

---

## Test Case 3: Theme Mapping

Test various color requests map to correct themes:

| User Says | Expected Theme |
|-----------|---------------|
| "purple theme" | lavender |
| "blue theme" | glacier |
| "default theme" | default |
| "lavender" | lavender |
| "cool colors" | glacier |

### Validation
- [ ] Correctly interprets color descriptions
- [ ] Falls back to "default" for unknown colors

---

## Test Case 4: Name Derivation

When user doesn't specify a name, agent should derive a reasonable one.

### Input
```
"Build a CRM"
```

### Expected Tool Call
```javascript
template.copy({
  template: "crm",
  name: "<reasonable-name>"  // e.g., "my-crm", "crm-app", "crm"
})
```

### Acceptable Names
- "my-crm"
- "crm-app"
- "crm"
- "sales-crm"

### Unacceptable Names
- ❌ "" (empty)
- ❌ "untitled"
- ❌ "new-project"
- ❌ Very long names with unnecessary words

---

## Test Case 5: Dry Run

### Input
```
"What would a kanban template look like? Don't actually create it."
```

### Expected Tool Call
```javascript
template.copy({
  template: "kanban",
  name: "<any>",
  dryRun: true
})
```

### Validation Criteria
- [ ] Included `dryRun: true`
- [ ] Explained the preview results
- [ ] Did NOT proceed to actual creation

---

## Test Case 6: template.list Usage

### Input
```
"What templates do you have for tracking things?"
```

### Expected Tool Call
```javascript
template.list({ query: "track" })
```

OR

```javascript
template.list()  // Then filter/explain results
```

### Validation Criteria
- [ ] Used template.list (not template.copy)
- [ ] Provided helpful summary of results
- [ ] Offered to create one of the options

---

## Test Case 7: Sequential Tool Calls

### Input
```
"Show me the available templates and then create a todo app"
```

### Expected Tool Calls (in order)
1. `template.list()`
2. `template.copy({ template: "todo-app", name: "..." })`

### Validation Criteria
- [ ] Called tools in correct order
- [ ] Showed template list before creating
- [ ] Completed both operations

---

## Parameter Validation Rules

### template.copy Parameters

| Parameter | Required | Type | Validation |
|-----------|----------|------|------------|
| template | Yes | string | Must be valid template name |
| name | Yes | string | Non-empty, reasonable length |
| theme | No | string | Must be valid theme name |
| dryRun | No | boolean | true or false |
| output | No | string | Valid path (usually omit) |
| skipInstall | No | boolean | Usually omit (let it install) |
| force | No | boolean | Usually omit |

### template.list Parameters

| Parameter | Required | Type | Validation |
|-----------|----------|------|------------|
| query | No | string | Search term |
| complexity | No | string | "beginner", "intermediate", "advanced" |

---

## Scoring

| Criterion | Points |
|-----------|--------|
| Correct template name | 30 |
| Correct name parameter | 20 |
| Correct optional params | 20 |
| No invalid params | 15 |
| Proper tool selection | 15 |
| **Total** | **100** |
